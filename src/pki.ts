/**
 * Device identity for Flower(TM) stations via mTLS client certificates.
 *
 * Certificates are issued by the internal CA (deploy/pki uses cloudflare/cfssl, BSD-2-Clause, run as
 * a separate tool), then registered here by a commander. A registered, unexpired, unrevoked cert
 * presented on a TLS connection authenticates as that station, the same as a station API key.
 * The cert names its station with a SAN URI: urn:infinitum:flower:<callsign>.
 */
import { X509Certificate } from 'node:crypto';
import { type DB, all, one, run, now } from './db.ts';
import { record } from './ledger.ts';
import { badRequest, conflict, notFound } from './errors.ts';
import type { Principal } from './auth.ts';

export const SAN_PREFIX = 'urn:infinitum:flower:';

const certView = (r: Record<string, any>) => ({
  fingerprint: r.fingerprint, serial: r.serial, subject: r.subject, stationId: r.station_id,
  notBefore: r.not_before, notAfter: r.not_after, createdAt: r.created_at, revokedAt: r.revoked_at,
});

function sanCallsign(cert: X509Certificate): string | null {
  const uris = (cert.subjectAltName ?? '').split(/,\s*/).filter((s) => s.startsWith('URI:')).map((s) => s.slice(4));
  const match = uris.find((u) => u.startsWith(SAN_PREFIX));
  return match ? match.slice(SAN_PREFIX.length) : null;
}

export function registerDeviceCert(db: DB, actor: string, ca: X509Certificate | null, pem: string) {
  if (!ca) throw conflict('no CA configured (set FP_CA_CERT)');
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    throw badRequest('not a valid PEM certificate');
  }
  if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey)) throw badRequest('certificate is not signed by the configured CA');
  if (cert.ca) throw badRequest('CA certificates cannot be registered as devices');
  if (Date.parse(cert.validTo) < Date.now()) throw badRequest('certificate has expired');
  const callsign = sanCallsign(cert);
  if (!callsign) throw badRequest(`certificate needs a SAN URI ${SAN_PREFIX}<callsign>`);
  const st = one(db, 'SELECT id FROM stations WHERE callsign = ?', callsign);
  if (!st) throw notFound(`station ${callsign}`);
  if (one(db, 'SELECT 1 FROM device_certs WHERE fingerprint = ?', cert.fingerprint256)) throw conflict('certificate already registered');

  run(db, `INSERT INTO device_certs (fingerprint, serial, subject, station_id, not_before, not_after, created_at)
           VALUES (?,?,?,?,?,?,?)`,
    cert.fingerprint256, cert.serialNumber, cert.subject, st.id,
    new Date(cert.validFrom).toISOString(), new Date(cert.validTo).toISOString(), now());
  record(db, actor, 'device_cert.registered', { fingerprint: cert.fingerprint256, serial: cert.serialNumber, stationId: st.id });
  return certView(one(db, 'SELECT * FROM device_certs WHERE fingerprint = ?', cert.fingerprint256)!);
}

export function revokeDeviceCert(db: DB, actor: string, fingerprint: string) {
  const r = one(db, 'SELECT * FROM device_certs WHERE fingerprint = ? AND revoked_at IS NULL', fingerprint);
  if (!r) throw notFound('active certificate');
  run(db, 'UPDATE device_certs SET revoked_at = ? WHERE fingerprint = ?', now(), fingerprint);
  record(db, actor, 'device_cert.revoked', { fingerprint, stationId: r.station_id });
}

export const listDeviceCerts = (db: DB) => all(db, 'SELECT * FROM device_certs ORDER BY created_at').map(certView);

/** Principal for a peer certificate fingerprint, or null if unknown, revoked or outside its validity window. */
export function authenticateCert(db: DB, fingerprint: string | undefined): Principal | null {
  if (!fingerprint) return null;
  const r = one(db, 'SELECT * FROM device_certs WHERE fingerprint = ? AND revoked_at IS NULL', fingerprint);
  if (!r) return null;
  const t = Date.now();
  if (t < Date.parse(r.not_before) || t > Date.parse(r.not_after)) return null;
  return { id: `cert:${fingerprint}`, name: r.subject.split('\n').find((l: string) => l.startsWith('CN='))?.slice(3) ?? 'device',
    role: 'station', stationId: r.station_id };
}
