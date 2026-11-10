import { openDb, tx } from './db.ts';
import { buildApp } from './app.ts';
import { createApiKey, hasAnyKey } from './auth.ts';
import { sweep } from './domain/missions.ts';
import { pruneTelemetry } from './domain/fleet.ts';
import { loadOrCreateSigner } from './commands.ts';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = process.env.FP_DB_PATH ?? './data/flower-pollen.db';
const SWEEP_MS = Number(process.env.FP_SWEEP_MS ?? 5000);

if (DB_PATH !== ':memory:') {
  const { mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(DB_PATH), { recursive: true });
}
const db = openDb(DB_PATH);

// First run: mint a commander key so the system can be configured. Printed once, stored hashed.
if (!hasAnyKey(db)) {
  const { key } = tx(db, () => createApiKey(db, 'system', 'bootstrap-commander', 'commander'));
  console.log(`\n[bootstrap] commander API key (shown once, store it securely):\n  ${key}\n`);
}

// Ed25519 key that signs every station command. Created (mode 0600) on first run; back it up.
const signer = loadOrCreateSigner(process.env.FP_SIGNING_KEY_PATH ?? './data/command-signing-key.pem');

// Optional HTTPS + station client certificates (mTLS). API keys keep working alongside.
const { FP_TLS_CERT, FP_TLS_KEY, FP_CA_CERT } = process.env;
const ca = FP_CA_CERT ? new X509Certificate(readFileSync(FP_CA_CERT)) : undefined;
const https = FP_TLS_CERT && FP_TLS_KEY
  ? {
      cert: readFileSync(FP_TLS_CERT),
      key: readFileSync(FP_TLS_KEY),
      ...(FP_CA_CERT ? { ca: readFileSync(FP_CA_CERT), requestCert: true, rejectUnauthorized: false } : {}),
      minVersion: 'TLSv1.3',
    }
  : undefined;
if (ca && !https) console.warn('[warn] FP_CA_CERT is set but TLS is off: certificates can be registered but not used to authenticate');

const app = buildApp(db, { logger: true, signer, ca, https });
app.log.info({ keyId: signer.keyId, tls: !!https, mtls: !!(https && ca) }, 'command signing key loaded');
const timer = setInterval(() => {
  try {
    const r = sweep(db);
    if (r.recalled.length || r.stationsOffline.length) app.log.warn({ sweep: r }, 'safety sweep actions');
  } catch (err) {
    app.log.error(err, 'sweep failed');
  }
}, SWEEP_MS);

// Raw telemetry is high-volume; keep it for a bounded window (mission/state history stays in the ledger).
const RETENTION_DAYS = Number(process.env.FP_TELEMETRY_RETENTION_DAYS ?? 30);
const retention = setInterval(() => {
  try {
    const removed = pruneTelemetry(db, new Date(Date.now() - RETENTION_DAYS * 86_400_000));
    if (removed) app.log.info({ removed }, 'pruned telemetry');
  } catch (err) {
    app.log.error(err, 'telemetry prune failed');
  }
}, 10 * 60_000);

const shutdown = async () => {
  clearInterval(timer);
  clearInterval(retention);
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: PORT, host: HOST });
