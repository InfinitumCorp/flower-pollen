import { randomUUID } from 'node:crypto';
import { type DB, type Row, all, one, run, now, tx } from '../db.ts';
import { record } from '../ledger.ts';
import { badRequest, conflict, notFound } from '../errors.ts';

// ---------- Flower(TM) stations ----------

export interface StationInput {
  callsign: string;
  kind: 'fixed' | 'portable';
  lat: number;
  lon: number;
  bayCount: number;
}

export const stationView = (r: Row) => ({
  id: r.id,
  callsign: r.callsign,
  kind: r.kind,
  position: { lat: r.lat, lon: r.lon },
  bayCount: r.bay_count,
  status: r.status,
  firmware: r.firmware,
  lastSeenAt: r.last_seen_at,
  createdAt: r.created_at,
});

export function createStation(db: DB, actor: string, input: StationInput) {
  return tx(db, () => {
    if (one(db, 'SELECT 1 FROM stations WHERE callsign = ?', input.callsign)) throw conflict('callsign already in use');
    const id = randomUUID();
    run(db, 'INSERT INTO stations (id, callsign, kind, lat, lon, bay_count, created_at) VALUES (?,?,?,?,?,?,?)',
      id, input.callsign, input.kind, input.lat, input.lon, input.bayCount, now());
    record(db, actor, 'station.created', { id, ...input });
    return getStation(db, id);
  });
}

export function getStationRow(db: DB, id: string): Row {
  const r = one(db, 'SELECT * FROM stations WHERE id = ?', id);
  if (!r) throw notFound('station');
  return r;
}

export const getStation = (db: DB, id: string) => stationView(getStationRow(db, id));
export const listStations = (db: DB) => all(db, 'SELECT * FROM stations ORDER BY callsign').map(stationView);

/** Heartbeats update liveness every time but only reach the ledger when status or firmware changes. */
export function stationHeartbeat(db: DB, actor: string, id: string, status: 'online' | 'degraded', firmware?: string) {
  return tx(db, () => {
    const prev = getStationRow(db, id);
    run(db, 'UPDATE stations SET status = ?, firmware = COALESCE(?, firmware), last_seen_at = ? WHERE id = ?',
      status, firmware ?? null, now(), id);
    if (prev.status !== status || (firmware && firmware !== prev.firmware)) {
      record(db, actor, 'station.status', { id, from: prev.status, to: status, firmware: firmware ?? prev.firmware });
    }
    return getStation(db, id);
  });
}

// ---------- POLLEN(TM) aircraft ----------

export type AircraftState =
  | 'docked' | 'charging' | 'ready' | 'launching' | 'airborne' | 'returning' | 'maintenance' | 'lost';

/** Allowed lifecycle transitions. Docking/recovery is handled by `dockAircraft`. */
const TRANSITIONS: Record<AircraftState, AircraftState[]> = {
  docked: ['charging', 'ready', 'maintenance'],
  charging: ['ready', 'docked', 'maintenance'],
  ready: ['charging', 'launching', 'maintenance'],
  launching: ['airborne', 'returning', 'lost'],
  airborne: ['returning', 'lost'],
  returning: ['lost'],
  maintenance: ['docked'],
  lost: [],
};

export const FLIGHT_STATES: AircraftState[] = ['launching', 'airborne', 'returning'];

export const aircraftView = (r: Row) => ({
  id: r.id,
  serial: r.serial,
  stationId: r.station_id,
  bay: r.bay,
  state: r.state,
  batteryPct: r.battery_pct,
  cycleCount: r.cycle_count,
  healthPct: r.health_pct,
  firmware: r.firmware,
  missionId: r.mission_id,
  lastPosition: r.last_lat == null ? null : { lat: r.last_lat, lon: r.last_lon, altM: r.last_alt_m },
  lastSeenAt: r.last_seen_at,
});

export function getAircraftRow(db: DB, id: string): Row {
  const r = one(db, 'SELECT * FROM aircraft WHERE id = ?', id);
  if (!r) throw notFound('aircraft');
  return r;
}

export const getAircraft = (db: DB, id: string) => aircraftView(getAircraftRow(db, id));

export function listAircraft(db: DB, filter: { stationId?: string; missionId?: string; state?: string } = {}) {
  return all(db,
    `SELECT * FROM aircraft WHERE (?1 IS NULL OR station_id = ?1) AND (?2 IS NULL OR mission_id = ?2)
       AND (?3 IS NULL OR state = ?3) ORDER BY serial`,
    filter.stationId ?? null, filter.missionId ?? null, filter.state ?? null).map(aircraftView);
}

function assertBayFree(db: DB, stationId: string, bay: number, exceptAircraft?: string) {
  const st = getStationRow(db, stationId);
  if (bay < 0 || bay >= st.bay_count) throw badRequest(`bay must be 0..${st.bay_count - 1}`);
  const taken = one(db, 'SELECT id FROM aircraft WHERE station_id = ? AND bay = ? AND id IS NOT ?', stationId, bay, exceptAircraft ?? null);
  if (taken) throw conflict(`bay ${bay} is occupied`);
}

export function registerAircraft(db: DB, actor: string, input: { serial: string; stationId: string; bay: number; firmware?: string }) {
  return tx(db, () => {
    if (one(db, 'SELECT 1 FROM aircraft WHERE serial = ?', input.serial)) throw conflict('serial already registered');
    assertBayFree(db, input.stationId, input.bay);
    const id = randomUUID();
    run(db, `INSERT INTO aircraft (id, serial, station_id, bay, state, firmware, created_at) VALUES (?,?,?,?, 'docked', ?, ?)`,
      id, input.serial, input.stationId, input.bay, input.firmware ?? null, now());
    record(db, actor, 'aircraft.registered', { id, ...input });
    return getAircraft(db, id);
  });
}

export function transitionAircraft(db: DB, actor: string, id: string, to: AircraftState, reason?: string) {
  return tx(db, () => {
    const a = getAircraftRow(db, id);
    if (a.state === to) return aircraftView(a);
    if (!TRANSITIONS[a.state as AircraftState].includes(to)) throw conflict(`cannot move aircraft from ${a.state} to ${to}`);
    run(db, 'UPDATE aircraft SET state = ? WHERE id = ?', to, id);
    record(db, actor, 'aircraft.state', { id, from: a.state, to, reason: reason ?? null });
    return getAircraft(db, id);
  });
}

/** Station-reported status for a docked aircraft (battery, health, charge state). */
export function reportDockedStatus(db: DB, actor: string, id: string,
  input: { batteryPct: number; healthPct?: number; state?: 'charging' | 'ready' | 'docked' }) {
  return tx(db, () => {
    const a = getAircraftRow(db, id);
    if (!['docked', 'charging', 'ready'].includes(a.state)) throw conflict(`aircraft is ${a.state}, not docked`);
    run(db, 'UPDATE aircraft SET battery_pct = ?, health_pct = COALESCE(?, health_pct), last_seen_at = ? WHERE id = ?',
      input.batteryPct, input.healthPct ?? null, now(), id);
    if (input.state && input.state !== a.state) transitionAircraft(db, actor, id, input.state);
    return getAircraft(db, id);
  });
}

/**
 * Aircraft physically docked at a Flower(TM) bay. Valid from any flight state or `lost` (recovery).
 * Counts one charge cycle, clears mission assignment and may complete the mission.
 */
export function dockAircraft(db: DB, actor: string, id: string, input: { stationId: string; bay: number; batteryPct: number },
  onDocked?: (missionId: string) => void) {
  return tx(db, () => {
    const a = getAircraftRow(db, id);
    if (![...FLIGHT_STATES, 'lost'].includes(a.state)) throw conflict(`aircraft is ${a.state}; only flying or lost aircraft can dock`);
    assertBayFree(db, input.stationId, input.bay, id);
    run(db, `UPDATE aircraft SET state = 'docked', station_id = ?, bay = ?, battery_pct = ?, cycle_count = cycle_count + 1,
               mission_id = NULL, last_seen_at = ? WHERE id = ?`,
      input.stationId, input.bay, input.batteryPct, now(), id);
    run(db, `UPDATE mission_cells SET status = 'unassigned', aircraft_id = NULL WHERE aircraft_id = ? AND status = 'assigned'`, id);
    record(db, actor, 'aircraft.docked', { id, from: a.state, ...input, missionId: a.mission_id });
    if (a.mission_id && onDocked) onDocked(a.mission_id);
    return getAircraft(db, id);
  });
}

// ---------- Track history & retention ----------

/** Most recent `limit` telemetry points for an aircraft, oldest first. */
export function track(db: DB, aircraftId: string, missionId?: string, limit = 1000) {
  getAircraftRow(db, aircraftId);
  return all(db, `SELECT ts, lat, lon, alt_m, battery_pct, mission_id FROM telemetry
                  WHERE aircraft_id = ?1 AND (?2 IS NULL OR mission_id = ?2) ORDER BY id DESC LIMIT ?3`,
    aircraftId, missionId ?? null, limit)
    .reverse()
    .map((r) => ({ ts: r.ts, lat: r.lat, lon: r.lon, altM: r.alt_m, batteryPct: r.battery_pct, missionId: r.mission_id }));
}

/** Deletes raw telemetry older than `before`. The ledger keeps mission and state history regardless. */
export function pruneTelemetry(db: DB, before: Date): number {
  return Number(run(db, 'DELETE FROM telemetry WHERE ts < ?', before.toISOString()).changes);
}

// ---------- Readiness & charge rotation ----------

export const LAUNCH_MIN_BATTERY = 90;
export const INSPECT_BELOW_HEALTH = 60;

/**
 * Ranks a station's docked aircraft for the next sortie. Prefers full batteries, then the
 * least-cycled airframes so wear spreads evenly across the fleet.
 */
export function readiness(db: DB, stationId: string) {
  getStationRow(db, stationId);
  const rows = all(db, `SELECT * FROM aircraft WHERE station_id = ? AND state IN ('docked','charging','ready','maintenance')`, stationId);
  const ranked = rows.map((r) => {
    let action: 'fly' | 'charge' | 'inspect' | 'in_maintenance';
    if (r.state === 'maintenance') action = 'in_maintenance';
    else if (r.health_pct < INSPECT_BELOW_HEALTH) action = 'inspect';
    else if (r.battery_pct >= LAUNCH_MIN_BATTERY) action = 'fly';
    else action = 'charge';
    return { ...aircraftView(r), action };
  });
  const order = { fly: 0, charge: 1, inspect: 2, in_maintenance: 3 };
  ranked.sort((x, y) => order[x.action] - order[y.action] || y.batteryPct - x.batteryPct || x.cycleCount - y.cycleCount);
  return {
    stationId,
    launchable: ranked.filter((r) => r.action === 'fly' && r.state === 'ready').length,
    aircraft: ranked,
  };
}

// ---------- Alerts ----------

export function raiseAlert(db: DB, a: { kind: string; severity: 'info' | 'warning' | 'critical'; detail: string;
  aircraftId?: string | null; missionId?: string | null; stationId?: string | null }) {
  run(db, 'INSERT INTO alerts (kind, severity, aircraft_id, mission_id, station_id, detail, created_at) VALUES (?,?,?,?,?,?,?)',
    a.kind, a.severity, a.aircraftId ?? null, a.missionId ?? null, a.stationId ?? null, a.detail, now());
  record(db, 'system', 'alert.raised', a);
}

export function listAlerts(db: DB, openOnly: boolean) {
  return all(db, `SELECT * FROM alerts WHERE (?1 = 0 OR acknowledged_at IS NULL) ORDER BY id DESC LIMIT 500`, openOnly ? 1 : 0)
    .map((r) => ({
      id: r.id, kind: r.kind, severity: r.severity, detail: r.detail, aircraftId: r.aircraft_id,
      missionId: r.mission_id, stationId: r.station_id, createdAt: r.created_at,
      acknowledgedBy: r.acknowledged_by, acknowledgedAt: r.acknowledged_at,
    }));
}

export function acknowledgeAlert(db: DB, actor: string, id: number) {
  return tx(db, () => {
    const res = run(db, 'UPDATE alerts SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL', actor, now(), id);
    if (res.changes === 0) throw notFound('open alert');
    record(db, actor, 'alert.acknowledged', { id });
  });
}

// ---------- Firmware attestation & data offload ----------

export function attestFirmware(db: DB, actor: string, input: { target: 'station' | 'aircraft'; version: string; sha256: string }) {
  return tx(db, () => {
    if (one(db, 'SELECT 1 FROM firmware_releases WHERE target = ? AND version = ?', input.target, input.version)) {
      throw conflict('release already attested');
    }
    const id = randomUUID();
    run(db, 'INSERT INTO firmware_releases (id, target, version, sha256, attested_by, created_at) VALUES (?,?,?,?,?,?)',
      id, input.target, input.version, input.sha256, actor, now());
    const hash = record(db, actor, 'firmware.attested', { id, ...input });
    return { id, ...input, attestedBy: actor, ledgerHash: hash };
  });
}

export const listFirmware = (db: DB) =>
  all(db, 'SELECT * FROM firmware_releases ORDER BY created_at DESC').map((r) => ({
    id: r.id, target: r.target, version: r.version, sha256: r.sha256, attestedBy: r.attested_by, createdAt: r.created_at,
  }));

/** Station reports an installed firmware image; it must match an attested release hash. */
export function reportFirmwareInstall(db: DB, actor: string, aircraftId: string, version: string, sha256: string) {
  // Quarantine must be committed even though the request fails, so the error is thrown after the transaction.
  const result = tx(db, () => {
    const a = getAircraftRow(db, aircraftId);
    if (FLIGHT_STATES.includes(a.state)) throw conflict('cannot update firmware in flight');
    const rel = one(db, `SELECT * FROM firmware_releases WHERE target = 'aircraft' AND version = ?`, version);
    if (!rel) throw badRequest(`firmware ${version} is not attested`);
    if (rel.sha256 !== sha256) {
      raiseAlert(db, { kind: 'firmware_hash_mismatch', severity: 'critical', aircraftId, stationId: a.station_id,
        detail: `reported hash for ${version} does not match attested release` });
      if (a.state !== 'maintenance') transitionAircraft(db, actor, aircraftId, 'maintenance', 'firmware hash mismatch');
      return null;
    }
    run(db, 'UPDATE aircraft SET firmware = ? WHERE id = ?', version, aircraftId);
    record(db, actor, 'aircraft.firmware_installed', { aircraftId, version, sha256 });
    return getAircraft(db, aircraftId);
  });
  if (!result) throw conflict('firmware hash mismatch; aircraft moved to maintenance');
  return result;
}

export function recordCapture(db: DB, actor: string, input: { aircraftId: string; stationId: string; missionId?: string;
  uri: string; sha256: string; bytes: number }) {
  return tx(db, () => {
    getAircraftRow(db, input.aircraftId);
    getStationRow(db, input.stationId);
    const id = randomUUID();
    run(db, 'INSERT INTO captures (id, aircraft_id, station_id, mission_id, uri, sha256, bytes, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, input.aircraftId, input.stationId, input.missionId ?? null, input.uri, input.sha256, input.bytes, now());
    const hash = record(db, actor, 'capture.offloaded', { id, ...input });
    return { id, ...input, ledgerHash: hash };
  });
}

export const listCaptures = (db: DB, missionId?: string) =>
  all(db, 'SELECT * FROM captures WHERE (?1 IS NULL OR mission_id = ?1) ORDER BY created_at DESC LIMIT 500', missionId ?? null)
    .map((r) => ({ id: r.id, aircraftId: r.aircraft_id, stationId: r.station_id, missionId: r.mission_id,
      uri: r.uri, sha256: r.sha256, bytes: r.bytes, createdAt: r.created_at }));
