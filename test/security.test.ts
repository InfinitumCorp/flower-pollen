import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { openDb, tx, type DB } from '../src/db.ts';
import { buildApp } from '../src/app.ts';
import { createApiKey } from '../src/auth.ts';
import { type SignedCommand, loadOrCreateSigner, verifyCommand } from '../src/commands.ts';
import { encodeTelemetryBatch } from '../src/proto.ts';

const area = [[0.001, 0], [0.004, 0], [0.004, 0.003], [0.001, 0.003]];

describe('signed commands and protobuf telemetry', () => {
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
    }
    await ok('S1', 'POST', `/v1/stations/${ids.S1}/heartbeat`, {});
    ids.aircraft = [];
    for (let i = 0; i < 2; i++) {
      const a = await ok('op', 'POST', '/v1/aircraft', { serial: `C-${i}`, stationId: ids.S1, bay: i });
      await ok('S1', 'POST', `/v1/aircraft/${a.id}/status`, { batteryPct: 100, state: 'ready' });
      ids.aircraft.push(a.id);
    }
    const m = await ok('op', 'POST', '/v1/missions', { name: 'cmd', stationId: ids.S1, area, minAltM: 10, maxAltM: 100,
      maxDurationS: 600, cellSizeM: 100, requestedAircraft: 2 });
    ids.mission = m.id;
    await ok('op', 'POST', `/v1/missions/${m.id}/submit`);
    await ok('cmd', 'POST', `/v1/missions/${m.id}/approve`);
    await ok('op', 'POST', `/v1/missions/${m.id}/launch`);
  });
  after(() => app.close());

  test('launch issues signed launch + task commands that verify on the station', async () => {
    const key = await ok('S1', 'GET', '/v1/signing-key');
    assert.equal(key.alg, 'Ed25519');
    const cmds: SignedCommand[] = await ok('S1', 'GET', `/v1/stations/${ids.S1}/commands`);
    assert.deepEqual(cmds.map((c) => c.body.kind), ['launch', 'task']);
    assert.deepEqual(cmds.map((c) => c.body.counter), [1, 2]);
    assert.deepEqual([...cmds[0].body.aircraftIds].sort(), [...ids.aircraft].sort());

    const assignments = cmds[1].body.params.assignments as Record<string, string[]>;
    const cells = await ok('op', 'GET', `/v1/missions/${ids.mission}/cells`);
    assert.equal(Object.values(assignments).flat().length, cells.length, 'task covers every cell by H3 index');

    let last = 0;
    for (const c of cmds) {
      assert.deepEqual(verifyCommand(key.publicKeyPem, c, { stationId: ids.S1, lastCounter: last, keyId: key.keyId }), { ok: true });
      last = c.body.counter;
    }
    // The station executes in order; the same command again is a replay.
    assert.deepEqual(verifyCommand(key.publicKeyPem, cmds[0], { stationId: ids.S1, lastCounter: last }), { ok: false, reason: 'replayed' });
    // Any edit to the body breaks the signature.
    const forged = structuredClone(cmds[0]);
    forged.body.aircraftIds = ['00000000-0000-4000-8000-000000000000'];
    assert.equal((verifyCommand(key.publicKeyPem, forged, { stationId: ids.S1, lastCounter: 0 }) as any).reason, 'bad_signature');
    // A different station rejects it, and so does anyone after expiry.
    assert.equal((verifyCommand(key.publicKeyPem, cmds[0], { stationId: ids.S2, lastCounter: 0 }) as any).reason, 'wrong_station');
    assert.equal((verifyCommand(key.publicKeyPem, cmds[0], { stationId: ids.S1, lastCounter: 0, at: new Date(Date.now() + 3600_000) }) as any).reason, 'expired');
    // A key the station doesn't know.
    const other = loadOrCreateSigner();
    assert.equal((verifyCommand(other.publicKeyPem, cmds[0], { stationId: ids.S1, lastCounter: 0 }) as any).reason, 'bad_signature');
  });

  test('stations are scoped to their own commands and ack once', async () => {
    assert.equal((await call('S2', 'GET', `/v1/stations/${ids.S1}/commands`)).status, 403);
    assert.deepEqual(await ok('S2', 'GET', `/v1/stations/${ids.S2}/commands`), []);
    const [first] = await ok('S1', 'GET', `/v1/stations/${ids.S1}/commands`);
    assert.equal((await call('S1', 'POST', `/v1/stations/${ids.S1}/commands/${first.body.id}/ack`, { status: 'executed' })).status, 204);
    assert.equal((await call('S1', 'POST', `/v1/stations/${ids.S1}/commands/${first.body.id}/ack`, { status: 'executed' })).status, 409);
    const after1 = await ok('S1', 'GET', `/v1/stations/${ids.S1}/commands?after=1`);
    assert.equal(after1[0].body.counter, 2);
    const all = await ok('cmd', 'GET', `/v1/stations/${ids.S1}/commands`);
    assert.equal(all[0].ack.status, 'executed');
  });

  test('protobuf telemetry: accepted, station-checked, and low battery issues signed return + retask', async () => {
    const [a0, a1] = ids.aircraft;
    const body = encodeTelemetryBatch({ stationId: ids.S1, sequence: 7, points: [
      { aircraftId: a0, tsUnixMs: Date.now(), lat: 0.0015, lon: 0.002, altM: 50, batteryPct: 95 },
      { aircraftId: a1, lat: 0.0015, lon: 0.003, altM: 50.5, batteryPct: 20 },
    ] });
    const res = await app.inject({ method: 'POST', url: '/v1/telemetry', payload: body,
      headers: { 'x-api-key': keys.S1, 'content-type': 'application/x-protobuf' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { accepted: 2, rejected: [], sequence: 7 });
    assert.equal((await ok('op', 'GET', `/v1/aircraft/${a1}`)).state, 'returning');
    assert.equal((await ok('op', 'GET', `/v1/aircraft/${a0}/track`)).at(-1).altM, 50);

    const cmds: SignedCommand[] = await ok('S1', 'GET', `/v1/stations/${ids.S1}/commands?after=2`);
    assert.deepEqual(cmds.map((c) => c.body.kind), ['return', 'task']);
    assert.deepEqual(cmds[0].body.aircraftIds, [a1]);
    assert.deepEqual(cmds[1].body.aircraftIds, [a0], 'remaining aircraft gets all cells');

    const wrong = await app.inject({ method: 'POST', url: '/v1/telemetry',
      payload: encodeTelemetryBatch({ stationId: ids.S2, points: [] }), headers: { 'x-api-key': keys.S1, 'content-type': 'application/x-protobuf' } });
    assert.equal(wrong.statusCode, 403);
    const junk = await app.inject({ method: 'POST', url: '/v1/telemetry', payload: Buffer.from([0xff, 0xff, 0xff]),
      headers: { 'x-api-key': keys.S1, 'content-type': 'application/x-protobuf' } });
    assert.equal(junk.statusCode, 400);
  });

  test('recall issues a signed recall command', async () => {
    await ok('op', 'POST', `/v1/missions/${ids.mission}/recall`, { reason: 'test' });
    const cmds: SignedCommand[] = await ok('S1', 'GET', `/v1/stations/${ids.S1}/commands?after=4`);
    assert.equal(cmds.at(-1)!.body.kind, 'recall');
    assert.deepEqual(cmds.at(-1)!.body.aircraftIds, [ids.aircraft[0]]);
  });
});

describe('mTLS station certificates', () => {
  const pki = mkdtempSync(join(tmpdir(), 'fp-pki-'));
  const gen = spawnSync('bash', ['scripts/dev-pki.sh', pki, 'FLOWER-T1'], { encoding: 'utf8' });
  const skip = gen.status !== 0 ? `dev PKI unavailable (needs bash + openssl): ${gen.stderr?.slice(0, 200)}` : false;
  const f = (n: string) => readFileSync(join(pki, n));

  let db: DB;
  let app: FastifyInstance;
  let port = 0;
  let commanderKey = '';
  let stationId = '';

  const req = (path: string, opts: { cert?: string; key?: string; method?: string; body?: unknown } = {}) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', ca: f('ca.pem'), servername: 'localhost',
        ...(opts.cert ? { cert: f(opts.cert), key: f(opts.key!) } : {}),
        headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}),
          ...(opts.cert ? {} : { 'x-api-key': commanderKey }) } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : null }));
      });
      r.on('error', reject);
      if (opts.body) r.write(JSON.stringify(opts.body));
      r.end();
    });

  before(async () => {
    if (skip) return;
    db = openDb();
    app = buildApp(db, {
      ca: new X509Certificate(f('ca.pem')),
      https: { cert: f('server.pem'), key: f('server-key.pem'), ca: f('ca.pem'), requestCert: true, rejectUnauthorized: false },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
    commanderKey = tx(db, () => createApiKey(db, 't', 'alpha', 'commander')).key;
    stationId = (await req('/v1/stations', { method: 'POST', body: { callsign: 'FLOWER-T1', kind: 'portable', lat: 0, lon: 0, bayCount: 4 } })).body.id;
  });
  after(async () => {
    if (app) await app.close();
    rmSync(pki, { recursive: true, force: true });
  });

  test('unregistered cert gets nothing; registered cert authenticates as its station', { skip }, async () => {
    const asStation = { cert: 'FLOWER-T1.pem', key: 'FLOWER-T1-key.pem' };
    assert.equal((await req('/v1/me', asStation)).status, 401);

    const reg = await req('/v1/device-certs', { method: 'POST', body: { pem: f('FLOWER-T1.pem').toString() } });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(reg.body.stationId, stationId);

    const me = await req('/v1/me', asStation);
    assert.equal(me.status, 200);
    assert.deepEqual([me.body.role, me.body.stationId, me.body.name], ['station', stationId, 'FLOWER-T1']);
    assert.equal((await req(`/v1/stations/${stationId}/heartbeat`, { ...asStation, method: 'POST', body: {} })).status, 200);

    // Revocation takes effect on the next request.
    assert.equal((await req(`/v1/device-certs/${reg.body.fingerprint}/revoke`, { method: 'POST' })).status, 204);
    assert.equal((await req('/v1/me', asStation)).status, 401);
  });

  test('certs not signed by the CA are refused at registration and at the TLS layer', { skip }, async () => {
    const r = await req('/v1/device-certs', { method: 'POST', body: { pem: f('rogue.pem').toString() } });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /not signed by the configured CA/);
    assert.equal((await req('/v1/me', { cert: 'rogue.pem', key: 'rogue-key.pem' })).status, 401);
    const caAsDevice = await req('/v1/device-certs', { method: 'POST', body: { pem: f('server.pem').toString() } });
    assert.equal(caAsDevice.status, 400, 'server cert has no station SAN');
  });
});
