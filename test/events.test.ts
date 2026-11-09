import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { openDb, tx, type DB } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { createApiKey } from '../src/auth.ts';

let db: DB;
let app: FastifyInstance;
let base: string;
const keys: Record<string, string> = {};
const ids: Record<string, string> = {};

const api = async (who: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'x-api-key': keys[who], ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/** Opens an SSE stream and collects parsed events until the stream ends or close() is called. */
function stream(who: string, query = '', lastEventId?: number) {
  const ctrl = new AbortController();
  const events: { id: number; type: string; data: any }[] = [];
  let ended = false;
  const done = (async () => {
    const res = await fetch(`${base}/v1/events${query}`, {
      headers: { 'x-api-key': keys[who], ...(lastEventId ? { 'last-event-id': String(lastEventId) } : {}) },
      signal: ctrl.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const f = Object.fromEntries(block.split('\n').filter((l) => !l.startsWith(':') && l.includes(': '))
            .map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
          if (f.data) events.push({ id: Number(f.id), type: f.event, data: JSON.parse(f.data) });
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') throw e;
    }
    ended = true;
  })();
  return { events, close: () => ctrl.abort(), done, isEnded: () => ended };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

before(async () => {
  db = openDb();
  app = buildApp(db, { sseHeartbeatMs: 50 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  tx(db, () => {
    keys.cmd = createApiKey(db, 'test', 'alpha', 'commander').key;
    keys.op = createApiKey(db, 'test', 'oscar', 'operator').key;
  });
  for (const cs of ['F1', 'F2']) {
    const st = await api('cmd', 'POST', '/v1/stations', { callsign: cs, kind: 'fixed', lat: 0, lon: 0, bayCount: 4 });
    ids[cs] = st.body.id;
    keys[cs] = (await api('cmd', 'POST', '/v1/keys', { name: cs, role: 'station', stationId: st.body.id })).body.key;
  }
});
after(() => app.close());

test('stream delivers committed events; stations see only their own Flower', async () => {
  const all = stream('cmd');
  const f2 = stream('F2');
  await new Promise((r) => setTimeout(r, 50));

  const a1 = await api('op', 'POST', '/v1/aircraft', { serial: 'P-1', stationId: ids.F1, bay: 0 });
  const a2 = await api('op', 'POST', '/v1/aircraft', { serial: 'P-2', stationId: ids.F2, bay: 0 });
  await api('F1', 'POST', `/v1/stations/${ids.F1}/heartbeat`, { status: 'online' });
  await api('F1', 'POST', `/v1/stations/${ids.F1}/heartbeat`, { status: 'online' }); // no change → no event

  await until(() => all.events.filter((e) => e.type === 'aircraft.registered').length === 2
    && all.events.some((e) => e.type === 'station.status'));
  await until(() => f2.events.some((e) => e.data.payload.id === a2.body.id));
  assert.equal(all.events.filter((e) => e.type === 'station.status').length, 1, 'repeat heartbeat is not recorded');
  assert.ok(!f2.events.some((e) => e.data.payload.id === a1.body.id), 'F2 must not see F1 aircraft');
  assert.ok(!f2.events.some((e) => e.type.startsWith('api_key.') || e.type === 'station.status'));
  const ids_ = all.events.map((e) => e.id);
  assert.deepEqual(ids_, [...ids_].sort((x, y) => x - y), 'ids are increasing ledger seqs');

  // A rejected request writes nothing to the stream.
  const before = all.events.length;
  assert.equal((await api('op', 'POST', '/v1/aircraft', { serial: 'P-1', stationId: ids.F1, bay: 1 })).status, 409);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(all.events.length, before);

  all.close(); f2.close();
  await Promise.all([all.done, f2.done]);
});

test('Last-Event-ID replays missed events, with type filter', async () => {
  const seqs = (await api('cmd', 'GET', '/v1/ledger?limit=1000')).body;
  const from = seqs[2].seq;
  const s = stream('cmd', '?types=aircraft.', from);
  await until(() => s.events.length >= 2);
  assert.ok(s.events.every((e) => e.type.startsWith('aircraft.') && e.id > from));
  s.close();
  await s.done;
});

test('key rotation: old key stops working and its open stream closes', async () => {
  const s = stream('F1');
  await new Promise((r) => setTimeout(r, 30));
  const rotated = await api('F1', 'POST', '/v1/me/rotate');
  assert.equal(rotated.status, 200);
  await until(() => s.isEnded(), 2000);
  assert.equal((await api('F1', 'GET', '/v1/me')).status, 401);
  keys.F1 = rotated.body.key;
  const me = await api('F1', 'GET', '/v1/me');
  assert.equal(me.body.stationId, ids.F1, 'replacement keeps the station binding');

  const list = (await api('cmd', 'GET', '/v1/keys')).body;
  assert.equal(list.filter((k: any) => k.name === 'F1' && !k.revokedAt).length, 1);
  assert.ok(!JSON.stringify(list).includes('key_hash'));
  assert.equal((await api('op', 'POST', `/v1/keys/${me.body.id}/rotate`)).status, 403);
});

test('track returns telemetry oldest first', async () => {
  await api('F1', 'POST', `/v1/stations/${ids.F1}/heartbeat`, { status: 'online' });
  const a = (await api('op', 'GET', `/v1/aircraft?stationId=${ids.F1}`)).body[0];
  await api('F1', 'POST', `/v1/aircraft/${a.id}/status`, { batteryPct: 100, state: 'ready' });
  const area = [[0.001, 0], [0.004, 0], [0.004, 0.003], [0.001, 0.003]];
  const m = (await api('op', 'POST', '/v1/missions', { name: 't', stationId: ids.F1, area, minAltM: 10, maxAltM: 100,
    maxDurationS: 600, requestedAircraft: 1 })).body;
  await api('op', 'POST', `/v1/missions/${m.id}/submit`);
  await api('cmd', 'POST', `/v1/missions/${m.id}/approve`);
  assert.equal((await api('op', 'POST', `/v1/missions/${m.id}/launch`)).status, 200);
  for (let i = 0; i < 3; i++) {
    await api('F1', 'POST', '/v1/telemetry', { points: [{ aircraftId: a.id, lon: 0.002 + i * 0.0001, lat: 0.001, altM: 50, batteryPct: 90 - i }] });
  }
  const t = (await api('op', 'GET', `/v1/aircraft/${a.id}/track?missionId=${m.id}&limit=2`)).body;
  assert.equal(t.length, 2);
  assert.deepEqual(t.map((p: any) => p.batteryPct), [89, 88]);
});
