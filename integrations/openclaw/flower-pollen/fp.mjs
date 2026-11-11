#!/usr/bin/env node
// fp: command-line client for the Flower(TM) & POLLEN(TM) fleet API, used by the OpenClaw skill.
// No dependencies; needs Node >= 18. Prints JSON. Never prints the API key.
//
// Env: FP_API_KEY (required; an `agent` key), FP_URL (default http://127.0.0.1:8080).
// For HTTPS with the internal CA, also set NODE_EXTRA_CA_CERTS=/path/to/ca.pem.

const BASE = (process.env.FP_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const KEY = process.env.FP_API_KEY;

const HELP = `fp <command> [args] [--flags]

Read
  whoami                         the key's role and name
  status                         fleet summary: stations, missions in flight, open alerts
  stations
  aircraft [--station ID] [--state S]
  missions [--status S]
  mission <missionId>
  cells <missionId>
  alerts [--all]                 open alerts (or all with --all)
  readiness <stationId>
  track <aircraftId> [--limit N]
  captures [--mission ID]
  events [--types a.,b.] [--seconds N] [--max N]   watch live events briefly

Safety actions (need --yes; ask a person first)
  ack <alertId> --yes
  recall <missionId> [reason] --yes
  abort <missionId> <reason> --yes           missions in flight only
  return <aircraftId> <reason> --yes         send one aircraft home`;

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && !['yes', 'all'].includes(name)) { flags[name] = next; i++; } else flags[name] = true;
    } else pos.push(a);
  }
  return { cmd: pos[0], args: pos.slice(1), flags };
}

class CliError extends Error {}

async function api(method, path, body) {
  if (!KEY) throw new CliError('FP_API_KEY is not set');
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { 'x-api-key': KEY, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new CliError(`cannot reach ${BASE}: ${e.cause?.code ?? e.message}`);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new CliError(`${method} ${path} -> ${res.status} ${data?.error ?? ''}: ${data?.message ?? JSON.stringify(data?.issues ?? data)}`);
  return data;
}

const qs = (o) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== true);
  return p.length ? '?' + new URLSearchParams(p).toString() : '';
};
const need = (v, what) => { if (!v) throw new CliError(`missing ${what}`); return v; };
const confirmGate = (flags, what) => {
  if (flags.yes !== true) throw new CliError(`${what} changes live operations: re-run with --yes after a person has confirmed`);
};

async function events(flags) {
  if (!KEY) throw new CliError('FP_API_KEY is not set');
  const seconds = Number(flags.seconds ?? 10);
  const max = Number(flags.max ?? 50);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), seconds * 1000);
  const out = [];
  try {
    const res = await fetch(BASE + '/v1/events' + qs({ types: flags.types }), { headers: { 'x-api-key': KEY }, signal: ctrl.signal });
    if (!res.ok) throw new CliError(`GET /v1/events -> ${res.status}`);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split('\n').find((l) => l.startsWith('data: '));
        if (data) out.push(JSON.parse(data.slice(6)));
        if (out.length >= max) { ctrl.abort(); break; }
      }
    }
  } catch (e) {
    if (e instanceof CliError) throw e;
    if (e.name !== 'AbortError') throw new CliError(`events: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  return { watchedSeconds: seconds, count: out.length, events: out };
}

async function run({ cmd, args, flags }) {
  switch (cmd) {
    case 'whoami': return api('GET', '/v1/me');
    case 'status': {
      const [stations, active, recalling, alerts] = await Promise.all([
        api('GET', '/v1/stations'), api('GET', '/v1/missions?status=active'), api('GET', '/v1/missions?status=recalling'),
        api('GET', '/v1/alerts?open=true')]);
      const bySeverity = alerts.reduce((m, a) => ({ ...m, [a.severity]: (m[a.severity] ?? 0) + 1 }), {});
      return {
        stations: stations.map((s) => ({ id: s.id, callsign: s.callsign, status: s.status, lastSeenAt: s.lastSeenAt })),
        missionsInFlight: [...active, ...recalling].map((m) => ({ id: m.id, name: m.name, status: m.status, stationId: m.stationId,
          coveragePct: m.coverage.pct, aircraftInFlight: m.aircraftInFlight })),
        openAlerts: { total: alerts.length, ...bySeverity, critical: alerts.filter((a) => a.severity === 'critical').slice(0, 20) },
      };
    }
    case 'stations': return api('GET', '/v1/stations');
    case 'aircraft': return api('GET', '/v1/aircraft' + qs({ stationId: flags.station, state: flags.state }));
    case 'missions': return api('GET', '/v1/missions' + qs({ status: flags.status }));
    case 'mission': return api('GET', `/v1/missions/${need(args[0], 'missionId')}`);
    case 'cells': return api('GET', `/v1/missions/${need(args[0], 'missionId')}/cells`);
    case 'alerts': return api('GET', '/v1/alerts' + qs({ open: flags.all ? 'false' : 'true' }));
    case 'readiness': return api('GET', `/v1/stations/${need(args[0], 'stationId')}/readiness`);
    case 'track': return api('GET', `/v1/aircraft/${need(args[0], 'aircraftId')}/track` + qs({ limit: flags.limit }));
    case 'captures': return api('GET', '/v1/captures' + qs({ missionId: flags.mission }));
    case 'events': return events(flags);
    case 'ack': confirmGate(flags, 'ack'); await api('POST', `/v1/alerts/${need(args[0], 'alertId')}/ack`); return { acknowledged: Number(args[0]) };
    case 'recall': confirmGate(flags, 'recall');
      return api('POST', `/v1/missions/${need(args[0], 'missionId')}/recall`, args[1] ? { reason: args.slice(1).join(' ') } : {});
    case 'abort': confirmGate(flags, 'abort');
      return api('POST', `/v1/missions/${need(args[0], 'missionId')}/abort`, { reason: need(args.slice(1).join(' '), 'reason') });
    case 'return': confirmGate(flags, 'return');
      return api('POST', `/v1/aircraft/${need(args[0], 'aircraftId')}/return`, { reason: need(args.slice(1).join(' '), 'reason') });
    case undefined: case 'help': case '--help': return HELP;
    default: throw new CliError(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

try {
  const out = await run(parse(process.argv.slice(2)));
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
} catch (e) {
  console.error(e instanceof CliError ? `fp: ${e.message}` : e);
  process.exit(1);
}
