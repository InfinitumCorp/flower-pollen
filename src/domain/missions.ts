import { randomUUID } from 'node:crypto';
import { type DB, type Row, all, one, run, now, tx } from '../db.ts';
import { record } from '../ledger.ts';
import { issueCommand } from '../commands.ts';
import { type Principal, actorOf, requireStationScope } from '../auth.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { type LonLat, type Ring, coverageCells, normalizeRing, pointInRing } from '../geo.ts';
import {
  FLIGHT_STATES, INSPECT_BELOW_HEALTH, LAUNCH_MIN_BATTERY, dockAircraft, getAircraft, getAircraftRow, getStationRow, raiseAlert,
} from './fleet.ts';

export type MissionStatus = 'draft' | 'pending_approval' | 'approved' | 'active' | 'recalling' | 'complete' | 'aborted';

export const RTB_BATTERY_PCT = 25;
export const STATION_STALE_MS = 60_000;
export const TELEMETRY_STALE_MS = 30_000;

export interface MissionInput {
  name: string;
  stationId: string;
  area: Ring;
  noGo: Ring[];
  minAltM: number;
  maxAltM: number;
  maxDurationS: number;
  cellSizeM: number;
  requestedAircraft: number;
}

function missionView(db: DB, r: Row) {
  const counts = one(db, `SELECT COUNT(*) AS total, SUM(status = 'covered') AS covered, SUM(status = 'assigned') AS assigned
                          FROM mission_cells WHERE mission_id = ?`, r.id)!;
  const total = Number(counts.total);
  const covered = Number(counts.covered ?? 0);
  return {
    id: r.id,
    name: r.name,
    status: r.status as MissionStatus,
    stationId: r.station_id,
    area: JSON.parse(r.area) as Ring,
    noGo: JSON.parse(r.no_go) as Ring[],
    limits: { minAltM: r.min_alt_m, maxAltM: r.max_alt_m, maxDurationS: r.max_duration_s },
    cellSizeM: r.cell_size_m,
    h3Resolution: r.h3_res,
    requestedAircraft: r.requested_aircraft,
    coverage: { cells: total, covered, assigned: Number(counts.assigned ?? 0), pct: total ? Math.round((covered / total) * 1000) / 10 : 0 },
    aircraftInFlight: Number(one(db, 'SELECT COUNT(*) AS n FROM aircraft WHERE mission_id = ?', r.id)!.n),
    createdBy: r.created_by,
    approvedBy: r.approved_by,
    createdAt: r.created_at,
    approvedAt: r.approved_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function getMissionRow(db: DB, id: string): Row {
  const r = one(db, 'SELECT * FROM missions WHERE id = ?', id);
  if (!r) throw notFound('mission');
  return r;
}

export const getMission = (db: DB, id: string) => missionView(db, getMissionRow(db, id));

export const listMissions = (db: DB, status?: string) =>
  all(db, 'SELECT * FROM missions WHERE (?1 IS NULL OR status = ?1) ORDER BY created_at DESC', status ?? null).map((r) => missionView(db, r));

/** Missions a station still has work for: active, recalling, or aborted but not yet closed out. */
export const listOpenMissionsForStation = (db: DB, stationId: string) =>
  all(db, `SELECT * FROM missions WHERE station_id = ? AND ended_at IS NULL AND status IN ('active','recalling','aborted')
           ORDER BY created_at DESC`, stationId).map((r) => missionView(db, r));

export function listCells(db: DB, missionId: string) {
  getMissionRow(db, missionId);
  return all(db, 'SELECT * FROM mission_cells WHERE mission_id = ? ORDER BY cell_id', missionId).map((c) => ({
    cellId: c.cell_id, h3: c.h3, center: [c.lon, c.lat] as LonLat, status: c.status, aircraftId: c.aircraft_id,
  }));
}

function setStatus(db: DB, actor: string, r: Row, to: MissionStatus, extra: Record<string, unknown> = {}) {
  run(db, 'UPDATE missions SET status = ? WHERE id = ?', to, r.id);
  record(db, actor, 'mission.status', { id: r.id, from: r.status, to, ...extra });
}

function expectStatus(r: Row, ...allowed: MissionStatus[]) {
  if (!allowed.includes(r.status)) throw conflict(`mission is ${r.status}; expected ${allowed.join(' | ')}`);
}

// ---------- Lifecycle: draft → pending_approval → approved → active → recalling → complete ----------

export function createMission(db: DB, p: Principal, input: MissionInput) {
  if (input.minAltM >= input.maxAltM) throw badRequest('minAltM must be below maxAltM');
  let area: Ring, noGo: Ring[], plan: ReturnType<typeof coverageCells>;
  try {
    area = normalizeRing(input.area);
    noGo = input.noGo.map(normalizeRing);
    plan = coverageCells(area, noGo, input.cellSizeM);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const { cells, res } = plan;
  if (cells.length === 0) throw badRequest('no surveyable cells: area is too small or fully inside no-go zones');

  return tx(db, () => {
    getStationRow(db, input.stationId);
    const id = randomUUID();
    run(db, `INSERT INTO missions (id, name, status, station_id, area, no_go, min_alt_m, max_alt_m, max_duration_s, cell_size_m,
               h3_res, requested_aircraft, created_by, created_at) VALUES (?,?, 'draft', ?,?,?,?,?,?,?,?,?,?,?)`,
      id, input.name, input.stationId, JSON.stringify(area), JSON.stringify(noGo), input.minAltM, input.maxAltM,
      input.maxDurationS, input.cellSizeM, res, input.requestedAircraft, p.id, now());
    const ins = db.prepare('INSERT INTO mission_cells (mission_id, cell_id, h3, lon, lat) VALUES (?,?,?,?,?)');
    for (const c of cells) ins.run(id, c.id, c.h3, c.center[0], c.center[1]);
    record(db, actorOf(p), 'mission.created', { id, ...input, area, noGo, h3Resolution: res, cells: cells.length });
    return getMission(db, id);
  });
}

export function submitMission(db: DB, p: Principal, id: string) {
  return tx(db, () => {
    const r = getMissionRow(db, id);
    expectStatus(r, 'draft');
    setStatus(db, actorOf(p), r, 'pending_approval');
    return getMission(db, id);
  });
}

/** Two-person rule: a commander other than the mission's author must approve before launch. */
export function approveMission(db: DB, p: Principal, id: string) {
  return tx(db, () => {
    const r = getMissionRow(db, id);
    expectStatus(r, 'pending_approval');
    if (r.created_by === p.id) throw forbidden('mission must be approved by someone other than its author');
    run(db, 'UPDATE missions SET approved_by = ?, approved_at = ? WHERE id = ?', p.id, now(), id);
    setStatus(db, actorOf(p), r, 'approved', { approvedBy: p.id });
    return getMission(db, id);
  });
}

export function rejectMission(db: DB, p: Principal, id: string, reason: string) {
  return tx(db, () => {
    const r = getMissionRow(db, id);
    expectStatus(r, 'pending_approval');
    setStatus(db, actorOf(p), r, 'draft', { rejected: true, reason });
    return getMission(db, id);
  });
}

export function launchMission(db: DB, p: Principal, id: string) {
  return tx(db, () => {
    const r = getMissionRow(db, id);
    expectStatus(r, 'approved');
    const st = getStationRow(db, r.station_id);
    if (st.status !== 'online') throw conflict(`station ${st.callsign} is ${st.status}`);

    const picks = all(db, `SELECT id FROM aircraft WHERE station_id = ? AND state = 'ready' AND battery_pct >= ? AND health_pct >= ?
                           ORDER BY battery_pct DESC, cycle_count ASC LIMIT ?`,
      r.station_id, LAUNCH_MIN_BATTERY, INSPECT_BELOW_HEALTH, r.requested_aircraft);
    if (picks.length === 0) throw conflict('no launch-ready aircraft at station');

    const actor = actorOf(p);
    for (const a of picks) {
      run(db, `UPDATE aircraft SET state = 'launching', mission_id = ?, bay = NULL WHERE id = ?`, id, a.id);
    }
    run(db, 'UPDATE missions SET started_at = ? WHERE id = ?', now(), id);
    setStatus(db, actor, r, 'active', { aircraft: picks.map((a) => a.id) });
    if (picks.length < r.requested_aircraft) {
      raiseAlert(db, { kind: 'launch_shortfall', severity: 'warning', missionId: id, stationId: r.station_id,
        detail: `launched ${picks.length} of ${r.requested_aircraft} requested aircraft` });
    }
    issueCommand(db, r.station_id, 'launch', {
      missionId: id,
      aircraftIds: picks.map((a) => a.id),
      params: { limits: { minAltM: r.min_alt_m, maxAltM: r.max_alt_m }, area: JSON.parse(r.area), noGo: JSON.parse(r.no_go) },
    });
    assignCells(db, id); // issues the matching 'task' command
    return getMission(db, id);
  });
}

/** Recall all aircraft. Used by operators, by full coverage, and by the duration limit. */
export function recallMission(db: DB, actor: string, id: string, reason: string) {
  return tx(db, () => {
    const r = getMissionRow(db, id);
    expectStatus(r, 'active');
    setStatus(db, actor, r, 'recalling', { reason });
    sendHome(db, actor, id, 'recall', reason);
    finalizeIfDone(db, id);
    return getMission(db, id);
  });
}

export function abortMission(db: DB, p: Principal, id: string, reason: string) {
  return tx(db, () => {
    const r = getMissionRow(db, id);
    expectStatus(r, 'draft', 'pending_approval', 'approved', 'active', 'recalling');
    const actor = actorOf(p);
    setStatus(db, actor, r, 'aborted', { reason });
    sendHome(db, actor, id, 'abort', reason);
    finalizeIfDone(db, id);
    return getMission(db, id);
  });
}

function sendHome(db: DB, actor: string, missionId: string, kind: 'recall' | 'abort', reason: string) {
  const flying = all(db, `SELECT id, state FROM aircraft WHERE mission_id = ? AND state IN ('launching','airborne')`, missionId);
  for (const a of flying) {
    run(db, `UPDATE aircraft SET state = 'returning' WHERE id = ?`, a.id);
    record(db, actor, 'aircraft.state', { id: a.id, from: a.state, to: 'returning', reason: `mission ${kind}` });
  }
  if (flying.length) {
    issueCommand(db, getMissionRow(db, missionId).station_id, kind,
      { missionId, aircraftIds: flying.map((a) => a.id), params: { reason } });
  }
  run(db, `UPDATE mission_cells SET status = 'unassigned', aircraft_id = NULL WHERE mission_id = ? AND status = 'assigned'`, missionId);
}

/** Closes out a recalling/aborted mission once no aircraft remain assigned to it. */
export function finalizeIfDone(db: DB, missionId: string) {
  const r = getMissionRow(db, missionId);
  if (!['recalling', 'aborted'].includes(r.status) || r.ended_at) return;
  const remaining = Number(one(db, 'SELECT COUNT(*) AS n FROM aircraft WHERE mission_id = ?', missionId)!.n);
  if (remaining > 0) return;
  run(db, 'UPDATE missions SET ended_at = ? WHERE id = ?', now(), missionId);
  if (r.status === 'recalling') setStatus(db, 'system', r, 'complete');
  else record(db, 'system', 'mission.closed', { id: missionId, status: r.status });
}

// ---------- Planner ----------

const bearing = (from: LonLat, to: LonLat) =>
  Math.atan2(to[1] - from[1], (to[0] - from[0]) * Math.cos((from[1] * Math.PI) / 180));

/**
 * Hands unassigned cells to the mission's flying aircraft as contiguous sectors (by bearing
 * from the station), topping up the least-loaded aircraft first so work stays balanced.
 * Called on launch and whenever an aircraft leaves the mission.
 */
export function assignCells(db: DB, missionId: string) {
  const r = getMissionRow(db, missionId);
  if (r.status !== 'active') return;
  const fleet = all(db, `SELECT a.id, (SELECT COUNT(*) FROM mission_cells c WHERE c.mission_id = ?1 AND c.aircraft_id = a.id
                                         AND c.status = 'assigned') AS load
                         FROM aircraft a WHERE a.mission_id = ?1 AND a.state IN ('launching','airborne') ORDER BY load, a.id`, missionId);
  const open = all(db, `SELECT cell_id, lon, lat FROM mission_cells WHERE mission_id = ? AND status = 'unassigned'`, missionId);
  if (open.length === 0) return;
  if (fleet.length === 0) {
    const alreadyOpen = one(db, `SELECT 1 FROM alerts WHERE kind = 'coverage_gap' AND mission_id = ? AND acknowledged_at IS NULL`, missionId);
    if (!alreadyOpen) {
      raiseAlert(db, { kind: 'coverage_gap', severity: 'warning', missionId,
        detail: `${open.length} cells unassigned: no aircraft available in mission` });
    }
    return;
  }
  const st = getStationRow(db, r.station_id);
  const home: LonLat = [st.lon, st.lat];
  open.sort((a, b) => bearing(home, [a.lon, a.lat]) - bearing(home, [b.lon, b.lat]));

  const totalLoad = fleet.reduce((s, a) => s + Number(a.load), 0) + open.length;
  const target = Math.ceil(totalLoad / fleet.length);
  const upd = db.prepare(`UPDATE mission_cells SET status = 'assigned', aircraft_id = ? WHERE mission_id = ? AND cell_id = ?`);
  let i = 0;
  for (const a of fleet) {
    const take = Math.max(0, target - Number(a.load));
    for (let k = 0; k < take && i < open.length; k++, i++) upd.run(a.id, missionId, open[i].cell_id);
  }
  for (let f = 0; i < open.length; i++, f++) upd.run(fleet[f % fleet.length].id, missionId, open[i].cell_id);
  record(db, 'system', 'mission.replanned', { id: missionId, cellsAssigned: open.length, aircraft: fleet.length });

  // Signed tasking: the full current assignment (H3 cells) for every flying aircraft.
  const assignments: Record<string, string[]> = Object.fromEntries(fleet.map((a) => [a.id, [] as string[]]));
  for (const c of all(db, `SELECT aircraft_id, h3 FROM mission_cells WHERE mission_id = ? AND status = 'assigned' ORDER BY cell_id`, missionId)) {
    assignments[c.aircraft_id]?.push(c.h3);
  }
  issueCommand(db, r.station_id, 'task', { missionId, aircraftIds: fleet.map((a) => a.id), params: { assignments } });
}

/** Takes an aircraft off its mission work (RTB or lost) and redistributes its cells. */
function releaseFromMission(db: DB, aircraftId: string, to: 'returning' | 'lost', reason: string, actor: string) {
  const a = getAircraftRow(db, aircraftId);
  run(db, 'UPDATE aircraft SET state = ? WHERE id = ?', to, aircraftId);
  record(db, actor, 'aircraft.state', { id: aircraftId, from: a.state, to, reason });
  if (to === 'returning' && a.station_id) {
    issueCommand(db, a.station_id, 'return', { missionId: a.mission_id, aircraftIds: [aircraftId], params: { reason } });
  }
  run(db, `UPDATE mission_cells SET status = 'unassigned', aircraft_id = NULL WHERE aircraft_id = ? AND status = 'assigned'`, aircraftId);
  if (to === 'lost') run(db, 'UPDATE aircraft SET mission_id = NULL WHERE id = ?', aircraftId);
  if (a.mission_id) {
    assignCells(db, a.mission_id);
    finalizeIfDone(db, a.mission_id);
  }
}

export function returnAircraft(db: DB, p: Principal, aircraftId: string, reason: string) {
  return tx(db, () => {
    const a = getAircraftRow(db, aircraftId);
    if (!['launching', 'airborne'].includes(a.state)) throw conflict(`aircraft is ${a.state}`);
    releaseFromMission(db, aircraftId, 'returning', reason, actorOf(p));
    return getAircraft(db, aircraftId);
  });
}

export function markLost(db: DB, p: Principal, aircraftId: string, reason: string) {
  return tx(db, () => {
    const a = getAircraftRow(db, aircraftId);
    requireStationScope(p, a.station_id);
    if (!FLIGHT_STATES.includes(a.state)) throw conflict(`aircraft is ${a.state}; only flying aircraft can be marked lost`);
    raiseAlert(db, { kind: 'aircraft_lost', severity: 'critical', aircraftId, missionId: a.mission_id, detail: reason });
    releaseFromMission(db, aircraftId, 'lost', reason, actorOf(p));
  });
}

export function dock(db: DB, p: Principal, aircraftId: string, input: { stationId: string; bay: number; batteryPct: number }) {
  requireStationScope(p, input.stationId);
  // A Flower docks its own aircraft. Another station's aircraft may only be taken in once it is
  // declared lost (recovery), so no station can pull a flying aircraft off someone else's mission.
  const a = getAircraftRow(db, aircraftId);
  if (p.role === 'station' && a.station_id !== p.stationId && a.state !== 'lost') {
    throw forbidden('only lost aircraft from another station can be recovered here');
  }
  return dockAircraft(db, actorOf(p), aircraftId, input, (missionId) => {
    assignCells(db, missionId);
    finalizeIfDone(db, missionId);
  });
}

export function markCellCovered(db: DB, p: Principal, missionId: string, cellId: number, aircraftId: string) {
  return tx(db, () => {
    const r = getMissionRow(db, missionId);
    expectStatus(r, 'active', 'recalling');
    requireStationScope(p, r.station_id);
    const c = one(db, 'SELECT * FROM mission_cells WHERE mission_id = ? AND cell_id = ?', missionId, cellId);
    if (!c) throw notFound('cell');
    if (c.status === 'covered') return getMission(db, missionId);
    const a = one(db, 'SELECT mission_id FROM aircraft WHERE id = ?', aircraftId);
    if (!a) throw notFound('aircraft');
    if (a.mission_id !== missionId) throw conflict('aircraft is not flying this mission');
    run(db, `UPDATE mission_cells SET status = 'covered', aircraft_id = ? WHERE mission_id = ? AND cell_id = ?`, aircraftId, missionId, cellId);
    record(db, actorOf(p), 'mission.cell_covered', { missionId, cellId, aircraftId });
    const left = Number(one(db, `SELECT COUNT(*) AS n FROM mission_cells WHERE mission_id = ? AND status != 'covered'`, missionId)!.n);
    if (left === 0 && r.status === 'active') recallMission(db, 'system', missionId, 'coverage complete');
    return getMission(db, missionId);
  });
}

// ---------- Telemetry & geofencing ----------

export interface TelemetryPoint {
  aircraftId: string;
  ts?: string;
  lat: number;
  lon: number;
  altM: number;
  batteryPct: number;
}

function alertOnce(db: DB, kind: string, severity: 'warning' | 'critical', aircraftId: string, missionId: string, detail: string) {
  const open = one(db, `SELECT 1 FROM alerts WHERE kind = ? AND aircraft_id = ? AND mission_id IS ? AND acknowledged_at IS NULL`,
    kind, aircraftId, missionId);
  if (!open) raiseAlert(db, { kind, severity, aircraftId, missionId, detail });
}

export function ingestTelemetry(db: DB, p: Principal, points: TelemetryPoint[]) {
  return tx(db, () => {
    let accepted = 0;
    const rejected: { aircraftId: string; reason: string }[] = [];
    const actor = actorOf(p);
    const ins = db.prepare('INSERT INTO telemetry (aircraft_id, mission_id, ts, lat, lon, alt_m, battery_pct) VALUES (?,?,?,?,?,?,?)');

    for (const pt of points) {
      const a = one(db, 'SELECT * FROM aircraft WHERE id = ?', pt.aircraftId);
      if (!a) { rejected.push({ aircraftId: pt.aircraftId, reason: 'unknown aircraft' }); continue; }
      if (!FLIGHT_STATES.includes(a.state)) { rejected.push({ aircraftId: pt.aircraftId, reason: `aircraft is ${a.state}` }); continue; }
      const m = a.mission_id ? getMissionRow(db, a.mission_id) : null;
      if (p.role === 'station' && m && m.station_id !== p.stationId) {
        rejected.push({ aircraftId: pt.aircraftId, reason: 'aircraft not on this station\'s mission' }); continue;
      }

      const ts = pt.ts ?? now();
      ins.run(a.id, a.mission_id, ts, pt.lat, pt.lon, pt.altM, pt.batteryPct);
      run(db, 'UPDATE aircraft SET last_lat = ?, last_lon = ?, last_alt_m = ?, battery_pct = ?, last_seen_at = ? WHERE id = ?',
        pt.lat, pt.lon, pt.altM, pt.batteryPct, now(), a.id);
      accepted++;

      let state = a.state;
      if (state === 'launching') {
        run(db, `UPDATE aircraft SET state = 'airborne' WHERE id = ?`, a.id);
        record(db, actor, 'aircraft.state', { id: a.id, from: 'launching', to: 'airborne', reason: 'first telemetry' });
        state = 'airborne';
      }
      if (!m) continue;

      const pos: LonLat = [pt.lon, pt.lat];
      const noGo = JSON.parse(m.no_go) as Ring[];
      if (noGo.some((z) => pointInRing(pos, z))) {
        alertOnce(db, 'no_go_breach', 'critical', a.id, m.id, `aircraft ${a.serial} entered a no-go zone`);
        if (state === 'airborne') { releaseFromMission(db, a.id, 'returning', 'no-go zone breach', 'system'); continue; }
      }
      if (state !== 'airborne') continue;
      if (pt.altM < m.min_alt_m || pt.altM > m.max_alt_m) {
        alertOnce(db, 'altitude_limit', 'warning', a.id, m.id,
          `aircraft ${a.serial} at ${pt.altM} m outside ${m.min_alt_m}-${m.max_alt_m} m`);
      }
      if (!pointInRing(pos, JSON.parse(m.area) as Ring)) {
        alertOnce(db, 'outside_area', 'warning', a.id, m.id, `aircraft ${a.serial} outside mission area`);
      }
      if (pt.batteryPct < RTB_BATTERY_PCT) {
        alertOnce(db, 'low_battery', 'warning', a.id, m.id, `aircraft ${a.serial} at ${pt.batteryPct}%: returning to Flower`);
        releaseFromMission(db, a.id, 'returning', 'low battery', 'system');
      }
    }
    return { accepted, rejected };
  });
}

// ---------- Periodic safety sweep ----------

/** Enforces mission duration limits and flags stale stations and silent aircraft. */
export function sweep(db: DB, at = Date.now()) {
  return tx(db, () => {
    const recalled: string[] = [];
    for (const m of all(db, `SELECT id, started_at, max_duration_s FROM missions WHERE status = 'active'`)) {
      if (at - Date.parse(m.started_at) > m.max_duration_s * 1000) {
        recallMission(db, 'system', m.id, 'max duration reached');
        recalled.push(m.id);
      }
    }
    const staleStations = all(db, `SELECT id, callsign, last_seen_at FROM stations WHERE status != 'offline'`)
      .filter((s) => !s.last_seen_at || at - Date.parse(s.last_seen_at) > STATION_STALE_MS);
    for (const s of staleStations) {
      run(db, `UPDATE stations SET status = 'offline' WHERE id = ?`, s.id);
      raiseAlert(db, { kind: 'station_offline', severity: 'critical', stationId: s.id, detail: `station ${s.callsign} stopped reporting` });
    }
    for (const a of all(db, `SELECT id, serial, mission_id, last_seen_at FROM aircraft WHERE state IN ('airborne','returning')`)) {
      if (!a.last_seen_at || at - Date.parse(a.last_seen_at) > TELEMETRY_STALE_MS) {
        alertOnce(db, 'telemetry_stale', 'critical', a.id, a.mission_id, `no telemetry from ${a.serial}; confirm status or mark lost`);
      }
    }
    return { recalled, stationsOffline: staleStations.map((s) => s.id) };
  });
}
