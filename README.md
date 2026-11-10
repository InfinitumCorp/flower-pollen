# Flower™ & POLLEN™ backend

The fleet operations service for **Flower™** stations and the **POLLEN™** ISR swarms they launch.
It manages stations and aircraft, gates missions behind human approval, plans area coverage
across the swarm, applies operator-set limits to live telemetry and keeps a tamper-evident
record of every action.

This is the backend service only. Flight control, on-aircraft autonomy and station firmware are
out of scope. Stations call this API to get their orders and to report status.

## Run

Requires Node ≥ 24. Node runs the TypeScript directly, with no build step. Storage uses the built-in `node:sqlite`.

```bash
npm install
npm start          # http://127.0.0.1:8080, DB at ./data/flower-pollen.db
npm test           # 25 tests: geo/H3, ledger, missions, events, keys, signed commands, protobuf, mTLS
npm run typecheck
npm run notices    # regenerate THIRD_PARTY_NOTICES.md after changing dependencies
```

On first start the server prints a **bootstrap commander key** once. Use it to create stations and other keys.
It also creates the **command-signing key** (`FP_SIGNING_KEY_PATH`). Back that file up: stations pin its public key.

Docker: `docker build -t flower-pollen . && docker run -p 8080:8080 -v fp-data:/data flower-pollen` (state lives in `/data`).
All settings are listed in [.env.example](.env.example).

| Env | Default | |
|---|---|---|
| `PORT` / `HOST` | `8080` / `127.0.0.1` | |
| `FP_DB_PATH` | `./data/flower-pollen.db` | `:memory:` for ephemeral |
| `FP_SWEEP_MS` | `5000` | safety sweep interval |
| `FP_TELEMETRY_RETENTION_DAYS` | `30` | raw telemetry older than this is deleted; the ledger keeps mission and state history |
| `FP_SIGNING_KEY_PATH` | `./data/command-signing-key.pem` | Ed25519 command-signing key, created on first run |
| `FP_TLS_CERT` / `FP_TLS_KEY` | | serve HTTPS (TLS 1.3) |
| `FP_CA_CERT` | | internal device CA: enables station client certificates (mTLS) |

## Roles

Callers authenticate with an `x-api-key` header. Stations may instead present a registered mTLS client certificate (see below).


| Role | Can |
|---|---|
| `commander` | everything below, plus create stations/keys, approve missions, attest firmware, read ledger |
| `operator` | register aircraft, plan/submit/launch/recall/abort missions, RTB or mark aircraft lost, ack alerts |
| `station` | **bound to one Flower™**: heartbeat, docked status, dock, telemetry, cell coverage, firmware install, data offload |
| `auditor` | read-only, including ledger and its verification |

## Mission lifecycle

```
draft ──submit──▶ pending_approval ──approve (different commander)──▶ approved ──launch──▶ active
  ▲                     │ reject                                                          │
  └─────────────────────┘                       recall (operator · full coverage · max duration)
                                                                                          ▼
                       aborted ◀──abort (any time before completion)──        recalling ──all docked/lost──▶ complete
```

* **Two-person rule:** the author can never approve their own mission.
* **Planning:** the area polygon is split into [H3](https://h3geo.org) hexagons. The resolution is chosen so a
  hexagon at the mission's location is closest to `cellSizeM` across. Hexagons whose centres fall in a no-go zone are dropped,
  and each cell carries its H3 index (`h3`) so other systems can join on it.
  On launch the station's best-charged, least-cycled `ready` aircraft (battery ≥ 90 %, health ≥ 60 %) are
  picked. Each gets a contiguous, load-balanced sector ordered by bearing from the station.
* **Self-healing:** when an aircraft returns (low battery, no-go breach, operator) or is lost, its cells are
  redistributed to the rest of the swarm straight away.
* **Telemetry checks:** entering a no-go zone raises a critical alert and sends the aircraft home. Battery below 25 % sends it home.
  Altitude out of limits or leaving the area raises a warning. Alerts are de-duplicated until acknowledged.
* **Safety sweep:** recalls missions past `maxDurationS`, marks silent stations offline and flags aircraft with
  stale telemetry. It never declares an aircraft lost on its own; a human does that.

## Station loop (Flower™ integration)

1. `POST /v1/stations/:id/heartbeat` every few seconds. A station silent for over 60 s goes offline.
2. `POST /v1/aircraft/:id/status` for docked aircraft (battery, health, `charging`/`ready`).
3. `GET /v1/stations/:id/commands?after=<last counter>` returns **signed commands** (below). Verify each one, execute it, then
   `POST /v1/stations/:id/commands/:commandId/ack` with `executed` or `rejected`. `GET /v1/stations/:id/orders` gives the same state as a
   plain snapshot, useful for display and debugging, but stations must act only on verified commands.
4. `POST /v1/telemetry` takes batched positions (up to 5000 points) as JSON, or as protobuf
   (`Content-Type: application/x-protobuf`, `infinitum.pollen.v1.TelemetryBatch` in [proto/pollen/v1/telemetry.proto](proto/pollen/v1/telemetry.proto)).
   The first point moves an aircraft from `launching` to `airborne`.
5. `POST /v1/missions/:id/cells/:cellId/covered` when a cell is mapped.
6. `POST /v1/aircraft/:id/dock` on recovery, then `POST /v1/captures` for each offloaded data manifest (Cumulus://Cloud™ URI + sha256).

## Signed commands

Every order to a Flower™ is an Ed25519-signed envelope: `launch`, `task` (the full set of H3 cells for each aircraft),
`return`, `recall` and `abort`. Each envelope carries the target station, a per-station `counter` that only goes up, and an `expiresAt` (5 min).
A station must reject a command unless all of these hold:

* the signature verifies against the public key it pinned from `GET /v1/signing-key` (`keyId` identifies it)
* `stationId` is its own
* `counter` is greater than the last command it executed (blocks replay)
* the command has not expired

`verifyCommand()` in [src/commands.ts](src/commands.ts) implements exactly these checks for station software to reuse.
The signature covers canonical JSON with keys sorted at every level.
The design follows the ideas in teslamotors/vehicle-command; no code was taken from it. Per-session key agreement and
verification on the aircraft itself are not built yet. **Get a crypto review before any flight use.**

## Station certificates (mTLS)

With `FP_TLS_CERT`, `FP_TLS_KEY` and `FP_CA_CERT` set, the server serves HTTPS and accepts client certificates from the internal CA.
A commander registers each station certificate with `POST /v1/device-certs {pem}`.

* The certificate must be signed by the CA, must not be a CA, must be unexpired, and must carry the SAN URI `urn:infinitum:flower:<callsign>`.
* After registration it authenticates as that station, exactly like a station API key.
* `POST /v1/device-certs/:fingerprint/revoke` takes effect on the next request and closes that station's event streams.

See [deploy/pki/README.md](deploy/pki/README.md) for cfssl configs. `scripts/dev-pki.sh` builds a throwaway openssl CA for development and tests.

## Live events

`GET /v1/events` is a Server-Sent Events stream of every ledger entry, sent only after the change is saved.
A rejected or rolled-back request never appears.

* Each event's `id` is its ledger sequence number. Reconnect with a `Last-Event-ID` header to receive what was missed (up to 10,000 events).
* `?types=mission.,alert.` filters by event-type prefix.
* Station keys only see events for their own Flower™ and never see key-management events.
* The caller's key or certificate is re-checked at every keep-alive (15 s). If it has been revoked or rotated, the stream is closed.

## Keys

`GET /v1/keys` lists keys without hashes. `POST /v1/keys/:id/rotate` (commander) or `POST /v1/me/rotate` (any key, for itself)
issues a replacement with the same name, role and station binding. The old key stops working at once.

## Other endpoints

`GET /v1/aircraft/:id/track?missionId=&limit=` returns an aircraft's recent telemetry, oldest first.
`GET /v1/stations/:id/readiness` ranks the station's aircraft for charge rotation: `fly` / `charge` / `inspect` / `in_maintenance`.
`POST /v1/firmware` attests a release hash. Stations then report installs, and a hash mismatch quarantines the aircraft in maintenance.
`GET /v1/ledger`, `GET /v1/ledger/verify` serve the hash-chained, append-only event log (SQLite triggers block UPDATE/DELETE).
This is the local stand-in for anchoring to Firmament Network™.

## Layout

```
src/
  server.ts          entry: DB, bootstrap key, signing key, TLS, sweep + retention timers
  app.ts             Fastify routes + zod validation + auth
  db.ts              schema, tx helper
  auth.ts            hashed API keys, roles, station scoping
  ledger.ts          hash chain
  events.ts          post-commit event bus behind /v1/events
  commands.ts        Ed25519 signed station commands + verifyCommand()
  pki.ts             station client-certificate registry and mTLS auth
  proto.ts           protobuf TelemetryBatch codec
  geo.ts             point-in-polygon, H3 coverage cells, haversine
  domain/fleet.ts    stations, aircraft state machine, readiness, alerts, firmware, captures
  domain/missions.ts lifecycle, planner, telemetry checks, safety sweep
test/                node:test suites (in-memory SQLite; mTLS tests build a temp PKI with bash + openssl)
proto/               POLLEN(TM) wire schemas
deploy/pki/         cfssl CA and profile configs
scripts/            notices generator, dev PKI
.github/workflows/   CI on a self-hosted runner: typecheck, tests (Node 24 + 26), notices drift check; Docker job (hosted, off until HOSTED_RUNNERS=true)
```

## Open-source dependencies

Third-party code is only ever pulled in as a dependency, never copied in. Licenses and NOTICE files are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Never use code from proprietary repos (e.g. Anduril Lattice), from GPL/AGPL repos, or from repos with no license.

## Next steps

* Supabase (Postgres) storage for multi-node deployment. The data layer is isolated in `db.ts` + domain modules,
  but every domain function would become async.
* Per-session command keys, verification on the aircraft itself (teslamotors/liblithium is a candidate), and a crypto review.
* Per-aircraft POLLEN™ certificates, and command-key rotation published alongside the old key.
* METATRON¹⁰⁰™ command UI and anchoring the ledger head to Firmament Network™.
* A better coverage planner (path ordering within each sector, wind- and endurance-aware sectoring).
