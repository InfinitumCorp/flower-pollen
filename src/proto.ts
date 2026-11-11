import protobuf from 'protobufjs';
import { fileURLToPath } from 'node:url';
import { badRequest } from './errors.ts';

const PROTO = fileURLToPath(new URL('../proto/pollen/v1/telemetry.proto', import.meta.url));
const TelemetryBatch = protobuf.loadSync(PROTO).lookupType('infinitum.pollen.v1.TelemetryBatch');

export const PROTOBUF_CONTENT_TYPE = 'application/x-protobuf';

export interface DecodedBatch {
  stationId: string;
  sequence: number;
  points: { aircraftId: string; ts?: string; lat: number; lon: number; altM: number; batteryPct: number }[];
}

/** Decodes a TelemetryBatch into the same shape the JSON endpoint accepts. */
export function decodeTelemetryBatch(buf: Buffer): DecodedBatch {
  let obj: any;
  try {
    obj = TelemetryBatch.toObject(TelemetryBatch.decode(buf), { longs: Number, defaults: true });
  } catch (e) {
    throw badRequest(`invalid TelemetryBatch: ${(e as Error).message}`);
  }
  for (const p of obj.points) {
    if (p.tsUnixMs > 0 && !Number.isFinite(new Date(p.tsUnixMs).getTime())) {
      throw badRequest(`invalid TelemetryBatch: ts_unix_ms ${p.tsUnixMs} is out of range`);
    }
  }
  return {
    stationId: obj.stationId,
    sequence: obj.sequence,
    points: obj.points.map((p: any) => ({
      aircraftId: p.aircraftId,
      ...(p.tsUnixMs > 0 ? { ts: new Date(p.tsUnixMs).toISOString() } : {}),
      lat: p.lat,
      lon: p.lon,
      // float32 on the wire; round away binary noise (e.g. 87.3 -> 87.30000305)
      altM: Math.round(p.altM * 100) / 100,
      batteryPct: Math.round(p.batteryPct * 100) / 100,
    })),
  };
}

/** Encoder for station software and tests. */
export function encodeTelemetryBatch(batch: { stationId?: string; sequence?: number;
  points: { aircraftId: string; tsUnixMs?: number; lat: number; lon: number; altM: number; batteryPct: number }[] }): Buffer {
  const msg = TelemetryBatch.fromObject(batch);
  return Buffer.from(TelemetryBatch.encode(msg).finish());
}
