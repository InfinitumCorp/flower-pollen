// OpenClaw integration: the server-enforced `agent` role, the schema migration that allows it,
// and the bundled `fp` CLI against a real server.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, tx, type DB } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { authenticate, createApiKey } from '../src/auth.ts';
import { loadOrCreateSigner } from '../src/commands.ts';

const FP = join(import.meta.dirname, '..', 'integrations', 'openclaw', 'flower-pollen', 'fp.mjs');
const area = [[0.001, 0], [0.004, 0], [0.004, 0.003], [0.001, 0.003]];

describe('OpenClaw agent role', () => {
  let db: DB;
  let app: FastifyInstance;
  let base = '';
  const keys: Record<string, string> = {};
  const ids: Record<string, any> = {};

  const call = async (who: string, method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as any, url, payload: payload as any, headers: { 'x-api-key': keys[who] } });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  const ok = async (who: string, method: string, url: string, payload?: unknown) => {
    const r = await call(who, method, url, payload);
    assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  // async on purpose: a sync spawn would block this process, and with it the server the CLI is calling
  const fp = (args: string[], key = keys.agent) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(process.execPath, [FP, ...args], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, FP_URL: base, FP_API_KEY: key } },
      (e, out, err) => resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out, err }));
  });
  const newMission = async () => {
    const m = await ok('op', 'POST', '/v1/missions', { name: 'oc', stationId: ids.S1, area, minAltM: 10, maxAltM: 100,
      maxDurationS: 600, cellSizeM: 100, requestedAircraft: 1 });
    return m.id as string;
  };
  const launch = async (id: string) => {
    await ok('op', 'POST', `/v1/missions/${id}/submit`);
    await ok('cmd2', 'POST', `/v1/missions/${id}/approve`);
    await ok('op', 'POST', `/v1/missions/${id}/launch`);
  };

  before(async () => {
    db = openDb();
    app = buildApp(db, { signer: loadOrCreateSigner() });
    tx(db, () => {
      keys.cmd = createApiKey(db, 't', 'alpha', 'commander').key;
      keys.cmd2 = createApiKey(db, 't', 'bravo', 'commander').key;
      keys.op = createApiKey(db, 't', 'oscar', 'operator').key;
    });
    keys.agent = (await ok('cmd', 'POST', '/v1/keys', { name: 'openclaw', role: 'agent' })).key;
    ids.S1 = (await ok('cmd', 'POST', '/v1/stations', { callsign: 'S1', kind: 'fixed', lat: 0, lon: 0, bayCount: 4 })).id;
    keys.S1 = (await ok('cmd', 'POST', '/v1/keys', { name: 'S1', role: 'station', stationId: ids.S1 })).key;
    await ok('S1', 'POST', `/v1/stations/${ids.S1}/heartbeat`, {});
    ids.aircraft = [];
    for (let i = 0; i < 3; i++) {
      const a = await ok('op', 'POST', '/v1/aircraft', { serial: `OC-${i}`, stationId: ids.S1, bay: i });
      await ok('S1', 'POST', `/v1/aircraft/${a.id}/status`, { batteryPct: 100, state: 'ready' });
      ids.aircraft.push(a.id);
    }
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  after(() => app.close());

  test('agent reads fleet state but cannot plan, approve, launch or manage keys', async () => {
    assert.equal((await call('agent', 'GET', '/v1/stations')).status, 200);
    assert.equal((await call('agent', 'GET', '/v1/alerts')).status, 200);
    const draft = await newMission();
    assert.equal((await call('agent', 'POST', '/v1/missions', { name: 'x', stationId: ids.S1, area, minAltM: 10, maxAltM: 100,
      maxDurationS: 600, requestedAircraft: 1 })).status, 403);
    assert.equal((await call('agent', 'POST', `/v1/missions/${draft}/submit`)).status, 403);
    await ok('op', 'POST', `/v1/missions/${draft}/submit`);
    assert.equal((await call('agent', 'POST', `/v1/missions/${draft}/approve`)).status, 403);
    await ok('cmd2', 'POST', `/v1/missions/${draft}/approve`);
    assert.equal((await call('agent', 'POST', `/v1/missions/${draft}/launch`)).status, 403);
    // cannot cancel planning work that people own
    assert.equal((await call('agent', 'POST', `/v1/missions/${draft}/abort`, { reason: 'x' })).status, 403);
    assert.equal((await call('agent', 'POST', '/v1/keys', { name: 'x', role: 'commander' })).status, 403);
    assert.equal((await call('agent', 'GET', '/v1/ledger')).status, 403);
    assert.equal((await call('agent', 'POST', `/v1/aircraft/${ids.aircraft[0]}/lost`, { reason: 'x' })).status, 403);
    await ok('op', 'POST', `/v1/missions/${draft}/abort`, { reason: 'cleanup' });
  });

  test('agent can bring aircraft home, abort a mission in flight and ack alerts', async () => {
    const m1 = await newMission();
    await launch(m1);
    const flying = (await ok('agent', 'GET', `/v1/aircraft?missionId=${m1}`))[0];
    assert.equal((await ok('agent', 'POST', `/v1/aircraft/${flying.id}/return`, { reason: 'operator asked' })).state, 'returning');
    const gap = (await ok('agent', 'GET', '/v1/alerts')).find((a: any) => a.missionId === m1);
    assert.ok(gap, 'expected a coverage alert once the only aircraft left');
    assert.equal((await call('agent', 'POST', `/v1/alerts/${gap.id}/ack`)).status, 204);
    assert.equal((await ok('agent', 'POST', `/v1/missions/${m1}/abort`, { reason: 'weather' })).status, 'aborted');
    await ok('S1', 'POST', `/v1/aircraft/${flying.id}/dock`, { stationId: ids.S1, bay: 0, batteryPct: 60 });
    await ok('S1', 'POST', `/v1/aircraft/${flying.id}/status`, { batteryPct: 100, state: 'ready' });
  });

  test('fp CLI reads status and refuses safety actions without --yes', async () => {
    const who = await fp(['whoami']);
    assert.equal(who.code, 0, who.err);
    assert.equal(JSON.parse(who.out).role, 'agent');
    assert.ok(!who.out.includes(keys.agent) && !who.err.includes(keys.agent), 'the key must never be printed');

    const m2 = await newMission();
    await launch(m2);
    const st = await fp(['status']);
    assert.equal(st.code, 0, st.err);
    assert.ok(JSON.parse(st.out).missionsInFlight.some((m: any) => m.id === m2));

    const refused = await fp(['recall', m2, 'test']);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /--yes/);
    assert.equal((await ok('op', 'GET', `/v1/missions/${m2}`)).status, 'active');

    const done = await fp(['recall', m2, 'test', '--yes']);
    assert.equal(done.code, 0, done.err);
    assert.ok(['recalling', 'complete'].includes(JSON.parse(done.out).status));

    const bad = await fp(['whoami'], 'fp_not_a_real_key');
    assert.equal(bad.code, 1);
    assert.match(bad.err, /401/);
  });
});

test('databases from before the agent role are migrated and keep their keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-mig-'));
  const path = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('commander','operator','station','auditor')), station_id TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL)`);
    old.close();
    let db = openDb(path);
    const legacy = tx(db, () => createApiKey(db, 't', 'legacy', 'commander'));
    db.close();

    // simulate the pre-migration CHECK again on a fresh old-style DB holding a key
    const path2 = join(dir, 'old2.db');
    const old2 = new DatabaseSync(path2);
    old2.exec(`CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('commander','operator','station','auditor')), station_id TEXT, revoked_at TEXT,
      created_at TEXT NOT NULL);
      INSERT INTO api_keys VALUES ('k1', 'kept', 'h', 'auditor', NULL, NULL, '2026-01-01T00:00:00Z');`);
    old2.close();
    db = openDb(path2);
    assert.equal((db.prepare(`SELECT name FROM api_keys WHERE id = 'k1'`).get() as any).name, 'kept');
    const agent = tx(db, () => createApiKey(db, 't', 'openclaw', 'agent'));
    assert.equal(authenticate(db, agent.key)?.role, 'agent');
    db.close();

    db = openDb(path);
    assert.equal(authenticate(db, legacy.key)?.role, 'commander');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
