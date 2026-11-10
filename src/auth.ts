import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type DB, all, one, run, now, tx } from './db.ts';
import { record } from './ledger.ts';
import { HttpError, forbidden } from './errors.ts';

export type Role = 'commander' | 'operator' | 'station' | 'auditor';
export const ROLES: Role[] = ['commander', 'operator', 'station', 'auditor'];

export interface Principal {
  id: string;
  name: string;
  role: Role;
  stationId: string | null;
}

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export function createApiKey(db: DB, actor: string, name: string, role: Role, stationId: string | null = null) {
  if (role === 'station' && !stationId) throw new HttpError(400, 'bad_request', 'station keys must be bound to a station');
  if (role !== 'station' && stationId) throw new HttpError(400, 'bad_request', 'only station keys can be bound to a station');
  const id = randomUUID();
  const key = `fp_${randomBytes(24).toString('base64url')}`;
  run(db, 'INSERT INTO api_keys (id, name, key_hash, role, station_id, created_at) VALUES (?,?,?,?,?,?)',
    id, name, hashKey(key), role, stationId, now());
  record(db, actor, 'api_key.created', { id, name, role, stationId });
  return { id, key };
}

export function revokeApiKey(db: DB, actor: string, id: string) {
  const res = run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), id);
  if (res.changes === 0) throw new HttpError(404, 'not_found', 'active key not found');
  record(db, actor, 'api_key.revoked', { id });
}

/** Issues a replacement key with the same name, role and station binding, and revokes the old one. */
export function rotateApiKey(db: DB, actor: string, id: string) {
  return tx(db, () => {
    const r = one(db, 'SELECT * FROM api_keys WHERE id = ? AND revoked_at IS NULL', id);
    if (!r) throw new HttpError(404, 'not_found', 'active key not found');
    run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', now(), id);
    const fresh = createApiKey(db, actor, r.name, r.role, r.station_id);
    record(db, actor, 'api_key.rotated', { from: id, to: fresh.id });
    return fresh;
  });
}

export const listApiKeys = (db: DB) =>
  all(db, 'SELECT id, name, role, station_id, created_at, revoked_at FROM api_keys ORDER BY created_at').map((r) => ({
    id: r.id, name: r.name, role: r.role, stationId: r.station_id, createdAt: r.created_at, revokedAt: r.revoked_at,
  }));

export function authenticate(db: DB, key: string | undefined): Principal | null {
  if (!key) return null;
  const r = one(db, 'SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', hashKey(key));
  return r ? { id: r.id, name: r.name, role: r.role, stationId: r.station_id } : null;
}

export function hasAnyKey(db: DB): boolean {
  return !!one(db, 'SELECT 1 FROM api_keys LIMIT 1');
}

export function requireRole(p: Principal | null, ...roles: Role[]): Principal {
  if (!p) throw new HttpError(401, 'unauthorized', 'missing or invalid x-api-key');
  if (!roles.includes(p.role)) throw forbidden(`requires role: ${roles.join(' | ')}`);
  return p;
}

/** Station keys may only act for their own Flower(TM). */
export function requireStationScope(p: Principal, stationId: string) {
  if (p.role === 'station' && p.stationId !== stationId) throw forbidden('station key not authorized for this station');
}

export const actorOf = (p: Principal) => `${p.role}:${p.name}`;
