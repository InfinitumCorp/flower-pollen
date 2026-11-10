/**
 * Signed station commands.
 *
 * Every order the backend gives a Flower(TM) (launch, task, return, recall, abort) is an Ed25519-signed
 * envelope carrying the target station, a per-station counter that only goes up, and an expiry.
 * A station executes a command only if the signature verifies against the published key, the
 * station id is its own, the counter is above the last one it executed, and it has not expired.
 * That blocks forged, misrouted, replayed and stale orders.
 *
 * Design follows the ideas in teslamotors/vehicle-command (Apache-2.0); no code is taken from it.
 * Per-session key agreement and on-aircraft verification are future work and need a crypto review
 * before any flight use.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type DB, all, one, run, now } from './db.ts';
import { record } from './ledger.ts';
import { notFound, conflict } from './errors.ts';

export type CommandKind = 'launch' | 'task' | 'return' | 'recall' | 'abort';

export interface CommandBody {
  v: 1;
  id: string;
  keyId: string;
  stationId: string;
  counter: number;
  kind: CommandKind;
  missionId: string | null;
  aircraftIds: string[];
  params: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string;
}

export interface SignedCommand {
  body: CommandBody;
  /** base64url Ed25519 signature over canonicalJson(body) */
  sig: string;
}

export interface Signer {
  keyId: string;
  privateKey: KeyObject;
  publicKeyPem: string;
}

export const COMMAND_TTL_S = 300;

/** JSON with object keys sorted at every level, so signer and verifier hash identical bytes. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function signerFrom(privateKey: KeyObject): Signer {
  const pub = createPublicKey(privateKey);
  const der = pub.export({ type: 'spki', format: 'der' });
  return {
    keyId: createHash('sha256').update(der).digest('hex').slice(0, 16),
    privateKey,
    publicKeyPem: pub.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** Loads the Ed25519 command key from `path`, creating it (mode 0600) on first run. No path = ephemeral key. */
export function loadOrCreateSigner(path?: string): Signer {
  if (path && existsSync(path)) return signerFrom(createPrivateKey(readFileSync(path)));
  const { privateKey } = generateKeyPairSync('ed25519');
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  return signerFrom(privateKey);
}

const signers = new WeakMap<DB, Signer>();

export function attachSigner(db: DB, signer: Signer) {
  signers.set(db, signer);
}

export function signerFor(db: DB): Signer {
  let s = signers.get(db);
  if (!s) {
    s = loadOrCreateSigner();
    signers.set(db, s);
  }
  return s;
}

/** Signs and queues a command for a station. Call inside the transaction that caused it. */
export function issueCommand(db: DB, stationId: string, kind: CommandKind,
  opts: { missionId?: string | null; aircraftIds?: string[]; params?: Record<string, unknown>; ttlS?: number } = {}): SignedCommand {
  const signer = signerFor(db);
  const counter = Number(one(db, 'SELECT COALESCE(MAX(counter), 0) AS c FROM station_commands WHERE station_id = ?', stationId)!.c) + 1;
  const issued = new Date();
  const body: CommandBody = {
    v: 1,
    id: randomUUID(),
    keyId: signer.keyId,
    stationId,
    counter,
    kind,
    missionId: opts.missionId ?? null,
    aircraftIds: opts.aircraftIds ?? [],
    params: opts.params ?? {},
    issuedAt: issued.toISOString(),
    expiresAt: new Date(issued.getTime() + (opts.ttlS ?? COMMAND_TTL_S) * 1000).toISOString(),
  };
  const sig = sign(null, Buffer.from(canonicalJson(body)), signer.privateKey).toString('base64url');
  run(db, 'INSERT INTO station_commands (id, station_id, counter, kind, body, sig, created_at) VALUES (?,?,?,?,?,?,?)',
    body.id, stationId, counter, kind, JSON.stringify(body), sig, body.issuedAt);
  record(db, 'system', 'command.issued', { id: body.id, stationId, counter, kind, missionId: body.missionId, aircraftIds: body.aircraftIds });
  return { body, sig };
}

export function listCommands(db: DB, stationId: string, afterCounter = 0, limit = 200) {
  return all(db, 'SELECT * FROM station_commands WHERE station_id = ? AND counter > ? ORDER BY counter LIMIT ?', stationId, afterCounter, limit)
    .map((r) => ({ body: JSON.parse(r.body) as CommandBody, sig: r.sig as string, ack: r.acked_at ? { status: r.ack_status, at: r.acked_at, detail: r.ack_detail } : null }));
}

export function ackCommand(db: DB, actor: string, stationId: string, id: string, status: 'executed' | 'rejected', detail?: string) {
  const r = one(db, 'SELECT * FROM station_commands WHERE id = ? AND station_id = ?', id, stationId);
  if (!r) throw notFound('command');
  if (r.acked_at) throw conflict('command already acknowledged');
  run(db, 'UPDATE station_commands SET acked_at = ?, ack_status = ?, ack_detail = ? WHERE id = ?', now(), status, detail ?? null, id);
  record(db, actor, 'command.acked', { id, stationId, counter: r.counter, kind: r.kind, status, detail: detail ?? null });
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'bad_signature' | 'wrong_station' | 'replayed' | 'expired' | 'unknown_key' };

/**
 * Station-side check, exported so Flower(TM) software and tests use the exact same rules.
 * `lastCounter` is the highest counter the station has already executed.
 */
export function verifyCommand(publicKeyPem: string, cmd: SignedCommand,
  expect: { stationId: string; lastCounter: number; keyId?: string; at?: Date }): VerifyResult {
  const key = createPublicKey(publicKeyPem);
  if (expect.keyId && cmd.body.keyId !== expect.keyId) return { ok: false, reason: 'unknown_key' };
  let valid = false;
  try {
    valid = verify(null, Buffer.from(canonicalJson(cmd.body)), key, Buffer.from(cmd.sig, 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };
  if (cmd.body.stationId !== expect.stationId) return { ok: false, reason: 'wrong_station' };
  if (cmd.body.counter <= expect.lastCounter) return { ok: false, reason: 'replayed' };
  if (Date.parse(cmd.body.expiresAt) < (expect.at ?? new Date()).getTime()) return { ok: false, reason: 'expired' };
  return { ok: true };
}
