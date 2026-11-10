import { EventEmitter } from 'node:events';

/** A ledger entry as published to live subscribers. `seq` doubles as the SSE event id. */
export interface LedgerEvent {
  seq: number;
  ts: string;
  actor: string;
  type: string;
  payload: any;
}

const bus = new EventEmitter();
bus.setMaxListeners(0);

// Events recorded inside a transaction are held until it commits, so subscribers never see
// changes that were rolled back. SQLite calls here are synchronous, so one buffer suffices.
let pending: LedgerEvent[] = [];

function emit(e: LedgerEvent) {
  try {
    bus.emit('event', e);
  } catch {
    // a faulty subscriber must never affect the write path
  }
}

export function stage(e: LedgerEvent, inTransaction: boolean) {
  if (inTransaction) pending.push(e);
  else emit(e);
}

export function flush() {
  const batch = pending;
  pending = [];
  for (const e of batch) emit(e);
}

export function discard() {
  pending = [];
}

export function subscribe(fn: (e: LedgerEvent) => void): () => void {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}
