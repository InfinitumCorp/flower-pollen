import { createHash } from 'node:crypto';
import { type DB, all, one, run, now } from './db.ts';
import { stage } from './events.ts';

export const GENESIS = '0'.repeat(64);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const digest = (prev: string, ts: string, actor: string, type: string, payload: string) =>
  sha256(`${prev}|${ts}|${actor}|${type}|${payload}`);

/** Append a tamper-evident event. Call inside the same transaction as the change it records. */
export function record(db: DB, actor: string, type: string, payload: unknown): string {
  const prev = (one(db, 'SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1')?.hash as string) ?? GENESIS;
  const ts = now();
  const body = JSON.stringify(payload ?? null);
  const hash = digest(prev, ts, actor, type, body);
  const res = run(db, 'INSERT INTO ledger (ts, actor, type, payload, prev_hash, hash) VALUES (?,?,?,?,?,?)', ts, actor, type, body, prev, hash);
  stage({ seq: Number(res.lastInsertRowid), ts, actor, type, payload: JSON.parse(body) }, db.isTransaction);
  return hash;
}

export function verify(db: DB): { ok: true; entries: number; head: string } | { ok: false; brokenAt: number } {
  let prev = GENESIS;
  const rows = all(db, 'SELECT * FROM ledger ORDER BY seq');
  for (const r of rows) {
    if (r.prev_hash !== prev || digest(prev, r.ts, r.actor, r.type, r.payload) !== r.hash) {
      return { ok: false, brokenAt: r.seq };
    }
    prev = r.hash;
  }
  return { ok: true, entries: rows.length, head: prev };
}

export function list(db: DB, afterSeq = 0, limit = 100) {
  return all(db, 'SELECT * FROM ledger WHERE seq > ? ORDER BY seq LIMIT ?', afterSeq, limit).map((r) => ({
    seq: r.seq,
    ts: r.ts,
    actor: r.actor,
    type: r.type,
    payload: JSON.parse(r.payload),
    prevHash: r.prev_hash,
    hash: r.hash,
  }));
}
