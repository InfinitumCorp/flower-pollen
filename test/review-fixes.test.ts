// Regression tests for the bug-review fixes: station isolation, input validation, alert dedupe,
// recall defaults, station orders, health and SSE replay truncation.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { openDb, tx, type DB } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { createApiKey } from '../src/auth.ts';
import { loadOrCreateSigner } from '../src/commands.ts';
import { encodeTelemetryBatch } from '../src/proto.ts';
import { record } from '../src/ledger.ts';

const area = [[0.001, 0], [0.004, 0], [0.004, 0.003], [0.001, 0.003]];

describe('review fixes', () => {
  let db: DB;
  let app: FastifyInstance;
  const keys: Record<string, string> = {};
  const ids: Record<string, any> = {};

  const call = async (who: string, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method: method as any, url, payload: payload as any, headers: { 'x-api-key': keys[who], ...headers } });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  const ok = async (who: string, method: string, url: string, payload?: unknown) => {
    const r = await call(who, method, url, payload);
    assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const newMission = async (requestedAircraft: number) => {
    const m = await ok('op', 'POST', '/v1/missions', { name: 'm', stationId: ids.S1, area, minAltM: 10, maxAltM: 100,
      maxDurationS: 600, cellSizeM: 100, requestedAircraft });
    return m.id as string;
  };
  const fly = async (missionId: string) => {
    await ok('op', 'POST', `/v1/missions/${missionId}/submit`);
    await ok('cmd2', 'POST', `/v1/missions/${missionId}/approve`);
    await ok('op', 'POST', `/v1/missions/${missionId}/launch`);
  };

  before(async () => {
    db = openDb();
    app = buildApp(db, { signer: loadOrCreateSigner() });
    tx(db, () => {
      keys.cmd = createApiKey(db, 't', 'alpha', 'commander').key;
      keys.cmd2 = createApiKey(db, 't', 'bravo', 'commander').key;
      keys.op = createApiKey(db, 't', 'oscar', 'operator').key;
    });
    for (const cs of ['S1', 'S2']) {
      ids[cs] = (await ok('cmd', 'POST', '/v1/stations', { callsign: cs, kind: 'fixed', lat: 0, lon: 0, bayCount: 4 })).id;
      keys[cs] = (await ok('cmd', 'POST', '/v1/keys', { name: cs, role: 'station', stationId: ids[cs] })).key;
      await ok(cs, 'POST', `/v1/stations/${ids[cs]}/heartbeat`, {});
    }
    ids.aircraft = [];
    for (let i = 0; i < 3; i++) {
      const a = await ok('op', 'POST', '/v1/aircraft', { serial: `R-${i}`, stationId: ids.S1, bay: i });
      await ok('S1', 'POST', `/v1/aircraft/${a.id}/status`, { batteryPct: 100, state: 'ready' });
      ids.aircraft.push(a.id);
    }
    ids.mission = await newMission(2);
    await fly(ids.mission);
  });
  after(() => app.close());

  test('a station cannot read, mark lost or dock another station\'s aircraft', async () => {
    const [a0] = ids.aircraft;
    assert.equal((await call('S2', 'GET', `/v1/aircraft/${a0}`)).status, 403);
    assert.equal((await call('S1', 'GET', `/v1/aircraft/${a0}`)).status, 200);
    assert.equal((await call('S2', 'POST', `/v1/aircraft/${a0}/lost`, { reason: 'x' })).status, 403);
    assert.equal((await call('S2', 'POST', `/v1/aircraft/${a0}/dock`, { stationId: ids.S2, bay: 0, batteryPct: 50 })).status, 403);
    assert.equal((await ok('op', 'GET', `/v1/aircraft/${a0}`)).state, 'launching');
  });

  test('cell coverage needs an aircraft that is flying the mission', async () => {
    const [a0, , spare] = ids.aircraft;
    const url = `/v1/missions/${ids.mission}/cells/0/covered`;
    assert.equal((await call('S1', 'POST', url, { aircraftId: '00000000-0000-4000-8000-000000000000' })).status, 404);
    assert.equal((await call('S1', 'POST', url, { aircraftId: spare })).status, 409);
    await ok('S1', 'POST', url, { aircraftId: a0 });
  });

  test('protobuf timestamps outside the Date range are a 400, not a 500', async () => {
    const buf = encodeTelemetryBatch({ points: [{ aircraftId: ids.aircraft[0], tsUnixMs: 9e15, lat: 0.002, lon: 0.002, altM: 50, batteryPct: 90 }] });
    const r = await call('S1', 'POST', '/v1/telemetry', buf, { 'content-type': 'application/x-protobuf' });
    assert.equal(r.status, 400);
  });

  test('coverage_gap is raised once while open, and a lost aircraft can be recovered by another station', async () => {
    const [a0, a1] = ids.aircraft;
    await ok('op', 'POST', `/v1/aircraft/${a0}/return`, { reason: 'test' });
    await ok('op', 'POST', `/v1/aircraft/${a1}/lost`, { reason: 'no contact' });
    await ok('S1', 'POST', `/v1/aircraft/${a0}/dock`, { stationId: ids.S1, bay: 0, batteryPct: 40 });
    // recovery of a lost aircraft at a different Flower is allowed
    await ok('S2', 'POST', `/v1/aircraft/${a1}/dock`, { stationId: ids.S2, bay: 1, batteryPct: 10 });
    const gaps = (await ok('op', 'GET', '/v1/alerts')).filter((x: any) => x.kind === 'coverage_gap' && x.missionId === ids.mission);
    assert.equal(gaps.length, 1);
  });

  test('recall accepts an empty JSON body and uses the default reason', async () => {
    const r = await ok('op', 'POST', `/v1/missions/${ids.mission}/recall`, {});
    assert.ok(['recalling', 'complete'].includes(r.status));
  });

  test('station orders leave out closed missions', async () => {
    const closed = await newMission(1);
    await ok('op', 'POST', `/v1/missions/${closed}/abort`, { reason: 'cancelled before launch' });
    const orders = await ok('S1', 'GET', `/v1/stations/${ids.S1}/orders`);
    assert.ok(!orders.missions.some((m: any) => m.missionId === closed));
  });

  test('health is a cheap liveness check', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ok: true, service: 'flower-pollen' });
  });
});

test('SSE replay past the limit ends with replay_truncated and a resumable id', async () => {
  const db = openDb();
  const app = buildApp(db, { signer: loadOrCreateSigner() });
  const key = tx(db, () => createApiKey(db, 't', 'aud', 'auditor').key);
  tx(db, () => { for (let i = 0; i < 10_050; i++) record(db, 'test', 'test.filler', { i }); });
  try {
    const r = await app.inject({ method: 'GET', url: '/v1/events', headers: { 'x-api-key': key, 'last-event-id': '1' } });
    const tail = r.body.slice(-200);
    assert.match(tail, /event: replay_truncated/);
    assert.match(tail, /id: 10001\n/);
  } finally {
    await app.close();
  }
});
