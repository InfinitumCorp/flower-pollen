import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { openDb, tx, type DB } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { createApiKey } from '../src/auth.ts';
import { sweep } from '../src/domain/missions.ts';

let db: DB;
let app: FastifyInstance;
const keys: Record<string, string> = {};
const ids: Record<string, any> = {};

const call = async (who: string | null, method: string, url: string, payload?: unknown) => {
  const res = await app.inject({
    method: method as any, url, payload: payload as any,
    headers: who ? { 'x-api-key': keys[who] } : {},
  });
  return { status: res.statusCode, body: res.body ? res.json() : null };
};
const ok = async (who: string, method: string, url: string, payload?: unknown) => {
  const r = await call(who, method, url, payload);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

// ~1 km square survey area east of the station; small no-go square in its SW corner
const area = [[0.001, 0], [0.01, 0], [0.01, 0.009], [0.001, 0.009]];
const noGo = [[0.001, 0], [0.003, 0], [0.003, 0.002], [0.001, 0.002]];

before(() => {
  db = openDb();
  app = buildApp(db);
  tx(db, () => {
    keys.cmdA = createApiKey(db, 'test', 'alpha', 'commander').key;
    keys.cmdB = createApiKey(db, 'test', 'bravo', 'commander').key;
    keys.op = createApiKey(db, 'test', 'oscar', 'operator').key;
    keys.aud = createApiKey(db, 'test', 'audrey', 'auditor').key;
  });
});
after(() => app.close());

test('auth: missing key → 401, wrong role → 403', async () => {
  assert.equal((await call(null, 'GET', '/v1/stations')).status, 401);
  assert.equal((await call('op', 'POST', '/v1/stations', {})).status, 403);
});

test('station setup with scoped station key', async () => {
  const st = await ok('cmdA', 'POST', '/v1/stations', { callsign: 'FLOWER-1', kind: 'portable', lat: 0, lon: 0, bayCount: 8 });
  ids.station = st.id;
  const st2 = await ok('cmdA', 'POST', '/v1/stations', { callsign: 'FLOWER-2', kind: 'fixed', lat: 1, lon: 1, bayCount: 4 });
  keys.st = (await ok('cmdA', 'POST', '/v1/keys', { name: 'flower-1', role: 'station', stationId: st.id })).key;
  keys.st2 = (await ok('cmdA', 'POST', '/v1/keys', { name: 'flower-2', role: 'station', stationId: st2.id })).key;

  assert.equal((await call('st2', 'POST', `/v1/stations/${st.id}/heartbeat`, {})).status, 403);
  const hb = await ok('st', 'POST', `/v1/stations/${st.id}/heartbeat`, { status: 'online', firmware: 'fl-1.0.0' });
  assert.equal(hb.status, 'online');
});

test('register aircraft and rank readiness', async () => {
  ids.aircraft = [];
  for (let i = 0; i < 4; i++) {
    const a = await ok('op', 'POST', '/v1/aircraft', { serial: `PLN-${i}`, stationId: ids.station, bay: i });
    ids.aircraft.push(a.id);
    await ok('st', 'POST', `/v1/aircraft/${a.id}/status`, { batteryPct: i === 3 ? 50 : 100 - i, state: 'ready' });
  }
  assert.equal((await call('op', 'POST', '/v1/aircraft', { serial: 'PLN-X', stationId: ids.station, bay: 0 })).status, 409);
  const r = await ok('op', 'GET', `/v1/stations/${ids.station}/readiness`);
  assert.equal(r.launchable, 3);
  assert.equal(r.aircraft[0].serial, 'PLN-0');
  assert.equal(r.aircraft.at(-1).action, 'charge');
});

test('mission needs approval from a different commander', async () => {
  const m = await ok('cmdA', 'POST', '/v1/missions', {
    name: 'self-approve check', stationId: ids.station, area, noGo: [], minAltM: 30, maxAltM: 120, maxDurationS: 600, requestedAircraft: 2,
  });
  await ok('cmdA', 'POST', `/v1/missions/${m.id}/submit`);
  assert.equal((await call('cmdA', 'POST', `/v1/missions/${m.id}/approve`)).status, 403);
  assert.equal((await call('cmdA', 'POST', `/v1/missions/${m.id}/launch`)).status, 409);
  await ok('cmdA', 'POST', `/v1/missions/${m.id}/abort`, { reason: 'test cleanup' });
});

test('full mission: plan → approve → launch → replan on RTB/no-go → cover → recall → complete', async () => {
  const m = await ok('op', 'POST', '/v1/missions', {
    name: 'Survey grid A', stationId: ids.station, area, noGo: [noGo], minAltM: 30, maxAltM: 120,
    maxDurationS: 1800, cellSizeM: 100, requestedAircraft: 3,
  });
  ids.mission = m.id;
  assert.equal(m.status, 'draft');
  const cells = await ok('op', 'GET', `/v1/missions/${m.id}/cells`);
  assert.ok(cells.length > 50 && cells.length < 100, `cells=${cells.length}`);

  await ok('op', 'POST', `/v1/missions/${m.id}/submit`);
  assert.equal((await call('op', 'POST', `/v1/missions/${m.id}/approve`)).status, 403);
  await ok('cmdB', 'POST', `/v1/missions/${m.id}/approve`);
  const launched = await ok('op', 'POST', `/v1/missions/${m.id}/launch`);
  assert.equal(launched.status, 'active');
  assert.equal(launched.aircraftInFlight, 3);
  assert.equal(launched.coverage.assigned, cells.length);

  const orders = await ok('st', 'GET', `/v1/stations/${ids.station}/orders`);
  const launch = orders.missions[0].launch;
  assert.equal(launch.length, 3);
  assert.ok(!launch.some((a: any) => a.id === ids.aircraft[3]), 'half-charged aircraft stays home');
  const loads = launch.map((a: any) => a.cells.length);
  assert.ok(Math.max(...loads) - Math.min(...loads) <= 1, `balanced loads ${loads}`);

  const [a0, a1, a2] = launch.map((a: any) => a.id);
  const tele = (aircraftId: string, lon: number, lat: number, batteryPct = 90, altM = 60) =>
    ok('st', 'POST', '/v1/telemetry', { points: [{ aircraftId, lon, lat, altM, batteryPct }] });

  for (const id of [a0, a1, a2]) await tele(id, 0.006, 0.005);
  assert.equal((await ok('op', 'GET', `/v1/aircraft/${a0}`)).state, 'airborne');

  // a1 drops below RTB battery → returns home, its cells go to a0/a2
  await tele(a1, 0.006, 0.005, 20);
  assert.equal((await ok('op', 'GET', `/v1/aircraft/${a1}`)).state, 'returning');
  let mm = await ok('op', 'GET', `/v1/missions/${m.id}`);
  assert.equal(mm.coverage.assigned, cells.length, 'all cells still assigned after replan');

  // a2 strays into the no-go zone → critical alert and RTB
  await tele(a2, 0.002, 0.001);
  assert.equal((await ok('op', 'GET', `/v1/aircraft/${a2}`)).state, 'returning');
  const alerts = await ok('op', 'GET', '/v1/alerts');
  assert.ok(alerts.some((a: any) => a.kind === 'no_go_breach' && a.severity === 'critical'));
  assert.ok(alerts.some((a: any) => a.kind === 'low_battery'));

  // altitude limit is a warning, not a recall
  await tele(a0, 0.006, 0.005, 80, 200);
  assert.equal((await ok('op', 'GET', `/v1/aircraft/${a0}`)).state, 'airborne');

  // dock the returners; mission stays active with a0 holding every cell
  await ok('st', 'POST', `/v1/aircraft/${a1}/dock`, { stationId: ids.station, bay: 1, batteryPct: 20 });
  await ok('st', 'POST', `/v1/aircraft/${a2}/dock`, { stationId: ids.station, bay: 2, batteryPct: 70 });
  mm = await ok('op', 'GET', `/v1/missions/${m.id}`);
  assert.equal(mm.status, 'active');
  assert.equal(mm.coverage.assigned, cells.length);

  // cover every cell → automatic recall
  for (const c of cells) await ok('st', 'POST', `/v1/missions/${m.id}/cells/${c.cellId}/covered`, { aircraftId: a0 });
  mm = await ok('op', 'GET', `/v1/missions/${m.id}`);
  assert.equal(mm.status, 'recalling');
  assert.equal(mm.coverage.pct, 100);
  assert.equal((await ok('op', 'GET', `/v1/aircraft/${a0}`)).state, 'returning');

  await ok('st', 'POST', `/v1/aircraft/${a0}/dock`, { stationId: ids.station, bay: 0, batteryPct: 40 });
  mm = await ok('op', 'GET', `/v1/missions/${m.id}`);
  assert.equal(mm.status, 'complete');
  assert.ok(mm.endedAt);
  assert.equal((await ok('op', 'GET', `/v1/aircraft/${a0}`)).cycleCount, 1);

  await ok('st', 'POST', '/v1/captures', {
    aircraftId: a0, stationId: ids.station, missionId: m.id, uri: 'https://cumulus.example/blob/abc', sha256: 'a'.repeat(64), bytes: 1024,
  });
});

test('lost aircraft and duration limit via safety sweep', async () => {
  const [a] = ids.aircraft;
  await ok('st', 'POST', `/v1/aircraft/${a}/status`, { batteryPct: 100, state: 'ready' });
  const m = await ok('op', 'POST', '/v1/missions', {
    name: 'short', stationId: ids.station, area, noGo: [], minAltM: 30, maxAltM: 120, maxDurationS: 60, requestedAircraft: 1,
  });
  await ok('op', 'POST', `/v1/missions/${m.id}/submit`);
  await ok('cmdA', 'POST', `/v1/missions/${m.id}/approve`);
  await ok('op', 'POST', `/v1/missions/${m.id}/launch`);

  const r = sweep(db, Date.now() + 61_000);
  assert.deepEqual(r.recalled, [m.id]);
  // the station's last heartbeat is now >60 s old too
  assert.ok(r.stationsOffline.includes(ids.station));
  assert.equal((await ok('op', 'GET', `/v1/missions/${m.id}`)).status, 'recalling');

  // aircraft never makes it back: operator declares it lost → mission closes
  await ok('op', 'POST', `/v1/aircraft/${a}/lost`, { reason: 'no contact after recall' });
  const mm = await ok('op', 'GET', `/v1/missions/${m.id}`);
  assert.equal(mm.status, 'complete');
  assert.equal((await ok('op', 'GET', `/v1/aircraft/${a}`)).state, 'lost');
  // recovered later
  await ok('st', 'POST', `/v1/aircraft/${a}/dock`, { stationId: ids.station, bay: 0, batteryPct: 5 });
  const offline = await ok('op', 'GET', '/v1/alerts');
  assert.ok(offline.some((x: any) => x.kind === 'station_offline'));
});

test('firmware must match an attested hash', async () => {
  const a = ids.aircraft[3];
  await ok('cmdA', 'POST', '/v1/firmware', { target: 'aircraft', version: 'pl-2.0.0', sha256: 'b'.repeat(64) });
  const good = await ok('st', 'POST', `/v1/aircraft/${a}/firmware`, { version: 'pl-2.0.0', sha256: 'b'.repeat(64) });
  assert.equal(good.firmware, 'pl-2.0.0');
  const bad = await call('st', 'POST', `/v1/aircraft/${a}/firmware`, { version: 'pl-2.0.0', sha256: 'c'.repeat(64) });
  assert.equal(bad.status, 409);
  assert.equal((await ok('op', 'GET', `/v1/aircraft/${a}`)).state, 'maintenance');
});

test('ledger records everything and verifies', async () => {
  assert.equal((await call('op', 'GET', '/v1/ledger')).status, 403);
  const v = await ok('aud', 'GET', '/v1/ledger/verify');
  assert.equal(v.ok, true);
  assert.ok(v.entries > 50);
  const entries = await ok('aud', 'GET', '/v1/ledger?limit=1000');
  for (const t of ['mission.created', 'mission.status', 'mission.replanned', 'aircraft.docked', 'firmware.attested', 'capture.offloaded', 'alert.raised']) {
    assert.ok(entries.some((e: any) => e.type === t), `missing ${t}`);
  }
});
