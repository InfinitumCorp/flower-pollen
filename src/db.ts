import { DatabaseSync } from 'node:sqlite';
import { discard, flush } from './events.ts';

export type DB = DatabaseSync;
export type Row = Record<string, any>;

const API_KEYS_DDL = `
CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('commander','operator','station','auditor','agent')),
  station_id  TEXT REFERENCES stations(id),
  revoked_at  TEXT,
  created_at  TEXT NOT NULL
);`;

const SCHEMA = `${API_KEYS_DDL}

-- Flower(TM) base stations
CREATE TABLE IF NOT EXISTS stations (
  id           TEXT PRIMARY KEY,
  callsign     TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('fixed','portable')),
  lat          REAL NOT NULL,
  lon          REAL NOT NULL,
  bay_count    INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','degraded','offline')),
  firmware     TEXT,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL
);

-- POLLEN(TM) aircraft
CREATE TABLE IF NOT EXISTS aircraft (
  id           TEXT PRIMARY KEY,
  serial       TEXT NOT NULL UNIQUE,
  station_id   TEXT REFERENCES stations(id),
  bay          INTEGER,
  state        TEXT NOT NULL,
  battery_pct  REAL NOT NULL DEFAULT 0,
  cycle_count  INTEGER NOT NULL DEFAULT 0,
  health_pct   REAL NOT NULL DEFAULT 100,
  firmware     TEXT,
  mission_id   TEXT REFERENCES missions(id),
  last_lat     REAL,
  last_lon     REAL,
  last_alt_m   REAL,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS aircraft_bay ON aircraft(station_id, bay) WHERE bay IS NOT NULL;

CREATE TABLE IF NOT EXISTS missions (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  status             TEXT NOT NULL,
  station_id         TEXT NOT NULL REFERENCES stations(id),
  area               TEXT NOT NULL,   -- JSON ring [[lon,lat],...]
  no_go              TEXT NOT NULL,   -- JSON array of rings
  min_alt_m          REAL NOT NULL,
  max_alt_m          REAL NOT NULL,
  max_duration_s     INTEGER NOT NULL,
  cell_size_m        REAL NOT NULL,
  h3_res             INTEGER NOT NULL,
  requested_aircraft INTEGER NOT NULL,
  created_by         TEXT NOT NULL,
  approved_by        TEXT,
  created_at         TEXT NOT NULL,
  approved_at        TEXT,
  started_at         TEXT,
  ended_at           TEXT
);

CREATE TABLE IF NOT EXISTS mission_cells (
  mission_id  TEXT NOT NULL REFERENCES missions(id),
  cell_id     INTEGER NOT NULL,
  h3          TEXT NOT NULL,       -- H3 hexagon index
  lon         REAL NOT NULL,
  lat         REAL NOT NULL,
  status      TEXT NOT NULL DEFAULT 'unassigned' CHECK (status IN ('unassigned','assigned','covered')),
  aircraft_id TEXT REFERENCES aircraft(id),
  PRIMARY KEY (mission_id, cell_id)
);

CREATE TABLE IF NOT EXISTS telemetry (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  aircraft_id TEXT NOT NULL REFERENCES aircraft(id),
  mission_id  TEXT,
  ts          TEXT NOT NULL,
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  alt_m       REAL NOT NULL,
  battery_pct REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS telemetry_aircraft_ts ON telemetry(aircraft_id, ts);
CREATE INDEX IF NOT EXISTS telemetry_ts ON telemetry(ts);

CREATE TABLE IF NOT EXISTS alerts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  aircraft_id     TEXT,
  mission_id      TEXT,
  station_id      TEXT,
  detail          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  acknowledged_by TEXT,
  acknowledged_at TEXT
);

CREATE TABLE IF NOT EXISTS firmware_releases (
  id          TEXT PRIMARY KEY,
  target      TEXT NOT NULL CHECK (target IN ('station','aircraft')),
  version     TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  attested_by TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (target, version)
);

-- Manifests for data offloaded by Flower(TM) to Cumulus://Cloud(TM)
CREATE TABLE IF NOT EXISTS captures (
  id          TEXT PRIMARY KEY,
  aircraft_id TEXT NOT NULL REFERENCES aircraft(id),
  station_id  TEXT NOT NULL REFERENCES stations(id),
  mission_id  TEXT,
  uri         TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

-- Signed orders to Flower(TM) stations; counter is per station and only increases
CREATE TABLE IF NOT EXISTS station_commands (
  id          TEXT PRIMARY KEY,
  station_id  TEXT NOT NULL REFERENCES stations(id),
  counter     INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  body        TEXT NOT NULL,
  sig         TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  acked_at    TEXT,
  ack_status  TEXT CHECK (ack_status IN ('executed','rejected')),
  ack_detail  TEXT,
  UNIQUE (station_id, counter)
);

-- mTLS client certificates issued by the internal CA (e.g. cfssl) to Flower(TM) stations
CREATE TABLE IF NOT EXISTS device_certs (
  fingerprint TEXT PRIMARY KEY,       -- sha256 of DER, uppercase hex with colons (Node format)
  serial      TEXT NOT NULL,
  subject     TEXT NOT NULL,
  station_id  TEXT NOT NULL REFERENCES stations(id),
  not_before  TEXT NOT NULL,
  not_after   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

-- Append-only, hash-chained record (local stand-in for Firmament Network(TM) anchoring)
CREATE TABLE IF NOT EXISTS ledger (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  actor     TEXT NOT NULL,
  type      TEXT NOT NULL,
  payload   TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
`;

export function openDb(path = ':memory:'): DB {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Brings databases created by older versions up to the current schema. */
function migrate(db: DB) {
  // v2: api_keys.role allows 'agent' (OpenClaw). SQLite can't alter a CHECK, so rebuild the table.
  const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'`).get() as { sql: string }).sql;
  if (sql.includes("'agent'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`ALTER TABLE api_keys RENAME TO api_keys_v1;
        ${API_KEYS_DDL}
        INSERT INTO api_keys SELECT * FROM api_keys_v1;
        DROP TABLE api_keys_v1;`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/** Run fn inside a transaction; nested calls join the outer transaction. */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  let result: T;
  try {
    result = fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    discard();
    throw err;
  }
  flush();
  return result;
}

export const one = (db: DB, sql: string, ...params: any[]): Row | undefined =>
  db.prepare(sql).get(...params) as Row | undefined;

export const all = (db: DB, sql: string, ...params: any[]): Row[] =>
  db.prepare(sql).all(...params) as Row[];

export const run = (db: DB, sql: string, ...params: any[]) => db.prepare(sql).run(...params);

export const now = () => new Date().toISOString();
