import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { type DB, one, tx } from './db.ts';
import { HttpError } from './errors.ts';
import * as ledger from './ledger.ts';
import { type LedgerEvent, subscribe } from './events.ts';
import type { TLSSocket } from 'node:tls';
import type { X509Certificate } from 'node:crypto';
import { type Signer, ackCommand, attachSigner, listCommands, signerFor } from './commands.ts';
import { PROTOBUF_CONTENT_TYPE, decodeTelemetryBatch } from './proto.ts';
import { authenticateCert, listDeviceCerts, registerDeviceCert, revokeDeviceCert } from './pki.ts';
import {
  type Principal, ROLES, actorOf, authenticate, createApiKey, listApiKeys, requireRole, requireStationScope, revokeApiKey,
  rotateApiKey,
} from './auth.ts';
import * as fleet from './domain/fleet.ts';
import * as missions from './domain/missions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

// ---------- Schemas ----------

const lonLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const ring = z.array(lonLat).min(3).max(500);
const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/, 'lowercase hex sha256');
const pct = z.number().min(0).max(100);

const StationBody = z.object({
  callsign: z.string().min(1).max(64),
  kind: z.enum(['fixed', 'portable']),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  bayCount: z.number().int().min(1).max(1024),
});
const MissionBody = z.object({
  name: z.string().min(1).max(120),
  stationId: uuid,
  area: ring,
  noGo: z.array(ring).max(100).default([]),
  minAltM: z.number().min(0).max(500),
  maxAltM: z.number().min(1).max(500),
  maxDurationS: z.number().int().min(60).max(24 * 3600),
  cellSizeM: z.number().min(10).max(5000).default(100),
  requestedAircraft: z.number().int().min(1).max(500),
});
const Telemetry = z.object({
  points: z.array(z.object({
    aircraftId: uuid,
    ts: z.string().datetime().optional(),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    altM: z.number().min(-100).max(10_000),
    batteryPct: pct,
  })).min(1).max(5000),
});
const Reason = z.object({ reason: z.string().min(1).max(500) });

const params = <T extends z.ZodRawShape>(shape: T) => z.object(shape);
const IdParam = params({ id: uuid });

export interface AppOptions {
  logger?: boolean;
  /** Keep-alive interval for /v1/events; the caller's key is re-checked on each tick. */
  sseHeartbeatMs?: number;
  /** Ed25519 key for signing station commands; an ephemeral key is generated if omitted. */
  signer?: Signer;
  /** Internal CA that issues station client certificates (enables /v1/device-certs and mTLS auth). */
  ca?: X509Certificate;
  /** Serve HTTPS (Node TLS options). Use requestCert: true to accept station client certificates. */
  https?: Record<string, unknown>;
}

const MAX_REPLAY = 10_000;

/**
 * Which Flower(TM) an event belongs to, for scoping station subscriptions.
 * `undefined` = never shown to stations (e.g. key management); `null` = fleet-wide, not station-specific.
 */
function eventStation(db: DB, e: LedgerEvent): string | null | undefined {
  if (e.type.startsWith('api_key.')) return undefined;
  const p = e.payload ?? {};
  if (typeof p.stationId === 'string') return p.stationId;
  if (e.type.startsWith('station.')) return p.id;
  const missionId = p.missionId ?? (e.type.startsWith('mission.') ? p.id : null);
  if (missionId) return (one(db, 'SELECT station_id FROM missions WHERE id = ?', missionId)?.station_id as string) ?? null;
  const aircraftId = p.aircraftId ?? (e.type.startsWith('aircraft.') ? p.id : null);
  if (aircraftId) return (one(db, 'SELECT station_id FROM aircraft WHERE id = ?', aircraftId)?.station_id as string) ?? null;
  return null;
}

export function buildApp(db: DB, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 4 * 1024 * 1024, ...(opts.https ? { https: opts.https as any } : {}) }) as unknown as FastifyInstance;
  if (opts.signer) attachSigner(db, opts.signer);
  const ca = opts.ca ?? null;

  /** Fingerprint of a CA-verified client certificate on this connection, if any. */
  const peerFingerprint = (req: FastifyRequest): string | undefined => {
    const sock = req.raw.socket as TLSSocket;
    if (!sock || typeof sock.getPeerCertificate !== 'function' || !sock.authorized) return undefined;
    return sock.getPeerCertificate()?.fingerprint256 || undefined;
  };
  /** Re-checks a principal for long-lived connections (key or cert may since have been revoked). */
  const stillValid = (p: Principal, key: string | undefined) =>
    p.id.startsWith('cert:') ? !!authenticateCert(db, p.id.slice(5)) : !!authenticate(db, key);

  app.decorateRequest('principal', null);
  app.addContentTypeParser(PROTOBUF_CONTENT_TYPE, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.addHook('onRequest', async (req) => {
    const key = req.headers['x-api-key'];
    // An API key wins when both are presented; otherwise a registered client certificate.
    req.principal = typeof key === 'string' ? authenticate(db, key) : authenticateCert(db, peerFingerprint(req));
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation_failed', issues: err.issues });
    }
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: 'bad_request', message: (err as Error).message });
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'internal error' });
  });

  const who = (req: FastifyRequest, ...roles: Parameters<typeof requireRole>[1][]) => requireRole(req.principal, ...roles);
  const ALL_HUMANS = ['commander', 'operator', 'auditor'] as const;

  // ---- Health ----
  // Cheap liveness only: a full chain check is O(ledger) and lives at /v1/ledger/verify (authenticated).
  app.get('/health', async () => {
    one(db, 'SELECT 1');
    return { ok: true, service: 'flower-pollen' };
  });

  // ---- API keys ----
  app.post('/v1/keys', async (req, reply) => {
    const p = who(req, 'commander');
    const b = z.object({ name: z.string().min(1).max(64), role: z.enum(ROLES as [string, ...string[]]),
      stationId: uuid.optional() }).parse(req.body);
    if (b.stationId) fleet.getStationRow(db, b.stationId);
    reply.status(201);
    return tx(db, () => createApiKey(db, actorOf(p), b.name, b.role as Principal['role'], b.stationId ?? null));
  });
  app.get('/v1/keys', async (req) => { who(req, 'commander'); return listApiKeys(db); });
  app.delete('/v1/keys/:id', async (req, reply) => {
    const p = who(req, 'commander');
    tx(db, () => revokeApiKey(db, actorOf(p), IdParam.parse(req.params).id));
    return reply.status(204).send();
  });
  app.post('/v1/keys/:id/rotate', async (req) => {
    const p = who(req, 'commander');
    return rotateApiKey(db, actorOf(p), IdParam.parse(req.params).id);
  });
  app.get('/v1/me', async (req) => who(req, ...ROLES));
  /** Any key can rotate itself, e.g. a Flower(TM) on a schedule. The old key stops working immediately. */
  app.post('/v1/me/rotate', async (req) => {
    const p = who(req, ...ROLES);
    return rotateApiKey(db, actorOf(p), p.id);
  });

  // ---- Live events (SSE) ----
  // Every ledger entry, published after commit. `id:` is the ledger seq, so clients resume with
  // Last-Event-ID and receive what they missed. Station keys only see their own Flower(TM).
  app.get('/v1/events', async (req, reply) => {
    const p = who(req, ...ROLES);
    const q = z.object({ types: z.string().max(500).optional() }).parse(req.query);
    const prefixes = q.types?.split(',').map((s) => s.trim()).filter(Boolean);
    const lastId = z.coerce.number().int().min(0).catch(0).parse(req.headers['last-event-id'] ?? 0);
    const key = req.headers['x-api-key'] as string | undefined;

    const visible = (e: LedgerEvent) =>
      (!prefixes || prefixes.some((t) => e.type.startsWith(t))) &&
      (p.role !== 'station' || eventStation(db, e) === p.stationId);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (e: LedgerEvent) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.write(': connected\n\n');

    // Replay and subscribe in one synchronous block so no event can slip between them.
    let cursor = lastId;
    if (lastId > 0) {
      let replayed = 0;
      for (let page = ledger.list(db, cursor, 1000); page.length && replayed < MAX_REPLAY; page = ledger.list(db, cursor, 1000)) {
        for (const e of page) {
          cursor = e.seq;
          replayed++;
          if (visible(e)) send(e);
        }
      }
      // More missed events than one replay allows: tell the client where we stopped (the `id:` moves
      // its Last-Event-ID past events it could not see) and close, so it reconnects for the next batch.
      if (ledger.list(db, cursor, 1).length) {
        res.end(`id: ${cursor}\nevent: replay_truncated\ndata: ${JSON.stringify({ resumeAfter: cursor })}\n\n`);
        return;
      }
    }
    const unsubscribe = subscribe((e) => {
      if (e.seq <= cursor) return;
      cursor = e.seq;
      if (visible(e)) send(e);
    });
    const heartbeat = setInterval(() => {
      if (!stillValid(p, key)) return close(); // key/cert revoked or rotated
      res.write(': ping\n\n');
    }, opts.sseHeartbeatMs ?? 15_000);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    req.raw.on('close', close);
  });

  // ---- Flower(TM) stations ----
  app.get('/v1/stations', async (req) => { who(req, ...ALL_HUMANS); return fleet.listStations(db); });
  app.post('/v1/stations', async (req, reply) => {
    const p = who(req, 'commander');
    reply.status(201);
    return fleet.createStation(db, actorOf(p), StationBody.parse(req.body));
  });
  app.get('/v1/stations/:id', async (req) => {
    const p = who(req, ...ROLES);
    const { id } = IdParam.parse(req.params);
    requireStationScope(p, id);
    return fleet.getStation(db, id);
  });
  app.post('/v1/stations/:id/heartbeat', async (req) => {
    const p = who(req, 'station');
    const { id } = IdParam.parse(req.params);
    requireStationScope(p, id);
    const b = z.object({ status: z.enum(['online', 'degraded']).default('online'), firmware: z.string().max(64).optional() }).parse(req.body ?? {});
    return fleet.stationHeartbeat(db, actorOf(p), id, b.status, b.firmware);
  });
  app.get('/v1/stations/:id/readiness', async (req) => {
    const p = who(req, ...ROLES);
    const { id } = IdParam.parse(req.params);
    requireStationScope(p, id);
    return fleet.readiness(db, id);
  });
  /** Work queue the Flower(TM) polls: aircraft to launch (with assigned cells) and aircraft to recover. */
  app.get('/v1/stations/:id/orders', async (req) => {
    const p = who(req, 'station', 'commander', 'operator');
    const { id } = IdParam.parse(req.params);
    requireStationScope(p, id);
    fleet.getStationRow(db, id);
    const out = missions.listOpenMissionsForStation(db, id).map((m) => {
      const cells = missions.listCells(db, m.id).filter((c) => c.status === 'assigned');
      const aircraft = fleet.listAircraft(db, { missionId: m.id }).map((a) => ({
        id: a.id, serial: a.serial, state: a.state,
        cells: cells.filter((c) => c.aircraftId === a.id).map((c) => ({ cellId: c.cellId, h3: c.h3, center: c.center })),
      }));
      return { missionId: m.id, status: m.status, limits: m.limits, noGo: m.noGo,
        launch: aircraft.filter((a) => a.state === 'launching'),
        recover: aircraft.filter((a) => a.state === 'returning'),
        tasks: aircraft.filter((a) => a.state === 'airborne') };
    });
    return { stationId: id, missions: out };
  });

  // ---- POLLEN(TM) aircraft ----
  app.get('/v1/aircraft', async (req) => {
    who(req, ...ALL_HUMANS);
    const q = z.object({ stationId: uuid.optional(), missionId: uuid.optional(), state: z.string().optional() }).parse(req.query);
    return fleet.listAircraft(db, q);
  });
  app.post('/v1/aircraft', async (req, reply) => {
    const p = who(req, 'commander', 'operator');
    const b = z.object({ serial: z.string().min(1).max(64), stationId: uuid, bay: z.number().int().min(0),
      firmware: z.string().max(64).optional() }).parse(req.body);
    reply.status(201);
    return fleet.registerAircraft(db, actorOf(p), b);
  });
  app.get('/v1/aircraft/:id', async (req) => {
    const p = who(req, ...ROLES);
    const a = fleet.getAircraft(db, IdParam.parse(req.params).id);
    requireStationScope(p, a.stationId);
    return a;
  });
  app.get('/v1/aircraft/:id/track', async (req) => {
    who(req, ...ALL_HUMANS);
    const q = z.object({ missionId: uuid.optional(), limit: z.coerce.number().int().min(1).max(10_000).default(1000) }).parse(req.query);
    return fleet.track(db, IdParam.parse(req.params).id, q.missionId, q.limit);
  });
  app.post('/v1/aircraft/:id/status', async (req) => {
    const p = who(req, 'station');
    const { id } = IdParam.parse(req.params);
    requireStationScope(p, fleet.getAircraftRow(db, id).station_id);
    const b = z.object({ batteryPct: pct, healthPct: pct.optional(), state: z.enum(['charging', 'ready', 'docked']).optional() }).parse(req.body);
    return fleet.reportDockedStatus(db, actorOf(p), id, b);
  });
  app.post('/v1/aircraft/:id/maintenance', async (req) => {
    const p = who(req, 'commander', 'operator', 'station');
    const { id } = IdParam.parse(req.params);
    const b = z.object({ action: z.enum(['enter', 'exit']), reason: z.string().max(500).optional() }).parse(req.body);
    if (p.role === 'station') requireStationScope(p, fleet.getAircraftRow(db, id).station_id);
    return fleet.transitionAircraft(db, actorOf(p), id, b.action === 'enter' ? 'maintenance' : 'docked', b.reason);
  });
  app.post('/v1/aircraft/:id/return', async (req) => {
    const p = who(req, 'commander', 'operator');
    return missions.returnAircraft(db, p, IdParam.parse(req.params).id, Reason.parse(req.body).reason);
  });
  app.post('/v1/aircraft/:id/lost', async (req, reply) => {
    const p = who(req, 'commander', 'operator', 'station');
    missions.markLost(db, p, IdParam.parse(req.params).id, Reason.parse(req.body).reason);
    return reply.status(204).send();
  });
  app.post('/v1/aircraft/:id/dock', async (req) => {
    const p = who(req, 'station');
    const b = z.object({ stationId: uuid, bay: z.number().int().min(0), batteryPct: pct }).parse(req.body);
    return missions.dock(db, p, IdParam.parse(req.params).id, b);
  });
  app.post('/v1/aircraft/:id/firmware', async (req) => {
    const p = who(req, 'station');
    const { id } = IdParam.parse(req.params);
    requireStationScope(p, fleet.getAircraftRow(db, id).station_id);
    const b = z.object({ version: z.string().min(1).max(64), sha256: sha }).parse(req.body);
    return fleet.reportFirmwareInstall(db, actorOf(p), id, b.version, b.sha256);
  });

  // ---- Telemetry ----
  /** JSON ({ points: [...] }) or protobuf (infinitum.pollen.v1.TelemetryBatch, application/x-protobuf). */
  app.post('/v1/telemetry', async (req) => {
    const p = who(req, 'station');
    if (Buffer.isBuffer(req.body)) {
      const batch = decodeTelemetryBatch(req.body);
      if (batch.stationId && batch.stationId !== p.stationId) throw new HttpError(403, 'forbidden', 'batch station_id does not match this station');
      return { ...missions.ingestTelemetry(db, p, Telemetry.parse({ points: batch.points }).points), sequence: batch.sequence };
    }
    return missions.ingestTelemetry(db, p, Telemetry.parse(req.body).points);
  });

  // ---- Missions ----
  app.get('/v1/missions', async (req) => {
    who(req, ...ALL_HUMANS);
    return missions.listMissions(db, z.object({ status: z.string().optional() }).parse(req.query).status);
  });
  app.post('/v1/missions', async (req, reply) => {
    const p = who(req, 'commander', 'operator');
    reply.status(201);
    return missions.createMission(db, p, MissionBody.parse(req.body));
  });
  app.get('/v1/missions/:id', async (req) => { who(req, ...ALL_HUMANS); return missions.getMission(db, IdParam.parse(req.params).id); });
  app.get('/v1/missions/:id/cells', async (req) => { who(req, ...ALL_HUMANS); return missions.listCells(db, IdParam.parse(req.params).id); });
  app.post('/v1/missions/:id/submit', async (req) =>
    missions.submitMission(db, who(req, 'commander', 'operator'), IdParam.parse(req.params).id));
  app.post('/v1/missions/:id/approve', async (req) =>
    missions.approveMission(db, who(req, 'commander'), IdParam.parse(req.params).id));
  app.post('/v1/missions/:id/reject', async (req) =>
    missions.rejectMission(db, who(req, 'commander'), IdParam.parse(req.params).id, Reason.parse(req.body).reason));
  app.post('/v1/missions/:id/launch', async (req) =>
    missions.launchMission(db, who(req, 'commander', 'operator'), IdParam.parse(req.params).id));
  app.post('/v1/missions/:id/recall', async (req) => {
    const p = who(req, 'commander', 'operator');
    const { reason } = z.object({ reason: Reason.shape.reason.default('operator recall') }).parse(req.body ?? {});
    return missions.recallMission(db, actorOf(p), IdParam.parse(req.params).id, reason);
  });
  app.post('/v1/missions/:id/abort', async (req) =>
    missions.abortMission(db, who(req, 'commander', 'operator'), IdParam.parse(req.params).id, Reason.parse(req.body).reason));
  app.post('/v1/missions/:id/cells/:cellId/covered', async (req) => {
    const p = who(req, 'station');
    const { id, cellId } = params({ id: uuid, cellId: z.coerce.number().int().min(0) }).parse(req.params);
    const b = z.object({ aircraftId: uuid }).parse(req.body);
    return missions.markCellCovered(db, p, id, cellId, b.aircraftId);
  });

  // ---- Alerts ----
  app.get('/v1/alerts', async (req) => {
    who(req, ...ALL_HUMANS);
    return fleet.listAlerts(db, z.object({ open: z.enum(['true', 'false']).default('true') }).parse(req.query).open === 'true');
  });
  app.post('/v1/alerts/:id/ack', async (req, reply) => {
    const p = who(req, 'commander', 'operator');
    fleet.acknowledgeAlert(db, actorOf(p), params({ id: z.coerce.number().int() }).parse(req.params).id);
    return reply.status(204).send();
  });

  // ---- Firmware attestation & captures ----
  app.get('/v1/firmware', async (req) => { who(req, ...ROLES); return fleet.listFirmware(db); });
  app.post('/v1/firmware', async (req, reply) => {
    const p = who(req, 'commander');
    const b = z.object({ target: z.enum(['station', 'aircraft']), version: z.string().min(1).max(64), sha256: sha }).parse(req.body);
    reply.status(201);
    return fleet.attestFirmware(db, actorOf(p), b);
  });
  app.post('/v1/captures', async (req, reply) => {
    const p = who(req, 'station');
    const b = z.object({ aircraftId: uuid, stationId: uuid, missionId: uuid.optional(), uri: z.string().url().max(2048),
      sha256: sha, bytes: z.number().int().min(0) }).parse(req.body);
    requireStationScope(p, b.stationId);
    reply.status(201);
    return fleet.recordCapture(db, actorOf(p), b);
  });
  app.get('/v1/captures', async (req) => {
    who(req, ...ALL_HUMANS);
    return fleet.listCaptures(db, z.object({ missionId: uuid.optional() }).parse(req.query).missionId);
  });

  // ---- Signed station commands ----
  app.get('/v1/signing-key', async (req) => {
    who(req, ...ROLES);
    const s = signerFor(db);
    return { keyId: s.keyId, alg: 'Ed25519', publicKeyPem: s.publicKeyPem };
  });
  /** A Flower(TM) fetches commands after the last counter it executed, verifies each, then acks it. */
  app.get('/v1/stations/:id/commands', async (req) => {
    const p = who(req, 'station', 'commander', 'operator', 'auditor');
    const { id } = IdParam.parse(req.params);
    requireStationScope(p, id);
    fleet.getStationRow(db, id);
    const q = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    return listCommands(db, id, q.after, q.limit);
  });
  app.post('/v1/stations/:id/commands/:commandId/ack', async (req, reply) => {
    const p = who(req, 'station');
    const { id, commandId } = params({ id: uuid, commandId: uuid }).parse(req.params);
    requireStationScope(p, id);
    const b = z.object({ status: z.enum(['executed', 'rejected']), detail: z.string().max(500).optional() }).parse(req.body);
    tx(db, () => ackCommand(db, actorOf(p), id, commandId, b.status, b.detail));
    return reply.status(204).send();
  });

  // ---- Device certificates (mTLS) ----
  app.get('/v1/device-certs', async (req) => { who(req, 'commander', 'auditor'); return listDeviceCerts(db); });
  app.post('/v1/device-certs', async (req, reply) => {
    const p = who(req, 'commander');
    const b = z.object({ pem: z.string().min(1).max(20_000) }).parse(req.body);
    reply.status(201);
    return tx(db, () => registerDeviceCert(db, actorOf(p), ca, b.pem));
  });
  app.post('/v1/device-certs/:fingerprint/revoke', async (req, reply) => {
    const p = who(req, 'commander');
    const { fingerprint } = params({ fingerprint: z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/) }).parse(req.params);
    tx(db, () => revokeDeviceCert(db, actorOf(p), fingerprint));
    return reply.status(204).send();
  });

  // ---- Ledger ----
  app.get('/v1/ledger', async (req) => {
    who(req, 'commander', 'auditor');
    const q = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(100) }).parse(req.query);
    return ledger.list(db, q.after, q.limit);
  });
  app.get('/v1/ledger/verify', async (req) => { who(req, 'commander', 'auditor'); return ledger.verify(db); });

  return app;
}
