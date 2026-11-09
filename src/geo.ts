import { UNITS, cellArea, cellToLatLng, getHexagonAreaAvg, latLngToCell, polygonToCells } from 'h3-js';

export type LonLat = [number, number];
export type Ring = LonLat[];

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQ = 111_320;
export const MAX_CELLS = 5000;

/** Ray-casting point-in-polygon. Ring may be open or closed. */
export function pointInRing([x, y]: LonLat, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function haversineM([lon1, lat1]: LonLat, [lon2, lat2]: LonLat): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Rough polygon area in m² via a local equirectangular projection (fine for mission-sized areas). */
export function areaM2(ring: Ring): number {
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = M_PER_DEG_LON_EQ * Math.cos((lat0 * Math.PI) / 180);
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * kx * ring[i][1] * M_PER_DEG_LAT - ring[i][0] * kx * ring[j][1] * M_PER_DEG_LAT;
  }
  return Math.abs(sum) / 2;
}

export interface CoverageCell {
  id: number;
  h3: string;
  center: LonLat;
}

const H3_MIN_RES = 6;
const H3_MAX_RES = 13;

/**
 * Area in m² of an H3 hexagon at `res`. H3 cell area varies by up to ~2x across the globe,
 * so when a location is given we measure the actual cell there instead of the global average.
 */
const hexAreaM2 = (res: number, at?: LonLat) =>
  at ? cellArea(latLngToCell(at[1], at[0], res), UNITS.m2) : getHexagonAreaAvg(res, UNITS.m2);

/** The H3 resolution whose hexagon size (√area) at `at` is closest to `cellSizeM` on a log scale. */
export function h3ResolutionFor(cellSizeM: number, at?: LonLat): number {
  let best = H3_MIN_RES;
  let bestErr = Infinity;
  for (let res = H3_MIN_RES; res <= H3_MAX_RES; res++) {
    const err = Math.abs(Math.log(Math.sqrt(hexAreaM2(res, at)) / cellSizeM));
    if (err < bestErr) [best, bestErr] = [res, err];
  }
  return best;
}

export const centroid = (ring: Ring): LonLat =>
  [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];

/**
 * Splits a survey area into H3 hexagons near `cellSizeM` across. Like H3 itself, a hexagon is
 * kept when its centre lies inside the area; no-go zones are passed as holes, and every centre
 * is re-checked so no cell is ever planned inside a no-go zone.
 */
export function coverageCells(area: Ring, noGo: Ring[], cellSizeM: number): { res: number; cells: CoverageCell[] } {
  const mid = centroid(area);
  const res = h3ResolutionFor(cellSizeM, mid);
  const estimate = areaM2(area) / hexAreaM2(res, mid);
  if (estimate > MAX_CELLS * 1.5) throw new RangeError(`area produces ~${Math.round(estimate)} cells (max ${MAX_CELLS})`);

  const toLatLng = (r: Ring) => r.map(([lon, lat]) => [lat, lon]);
  const indexes = polygonToCells([toLatLng(area), ...noGo.map(toLatLng)], res);
  if (indexes.length > MAX_CELLS) throw new RangeError(`area produces ${indexes.length} cells (max ${MAX_CELLS})`);

  const cells = indexes
    .map((h3) => {
      const [lat, lon] = cellToLatLng(h3);
      return { h3, center: [lon, lat] as LonLat };
    })
    .filter((c) => pointInRing(c.center, area) && !noGo.some((z) => pointInRing(c.center, z)))
    .sort((a, b) => (a.h3 < b.h3 ? -1 : 1)) // deterministic ids
    .map((c, id) => ({ id, ...c }));
  return { res, cells };
}

/** Validates a ring: ≥3 distinct vertices, valid coordinates, non-zero area. Returns it open (unclosed). */
export function normalizeRing(ring: Ring): Ring {
  const open = ring.length > 1 && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1] ? ring.slice(0, -1) : ring;
  if (open.length < 3) throw new RangeError('polygon needs at least 3 vertices');
  for (const [lon, lat] of open) {
    if (!(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90)) throw new RangeError('invalid coordinate');
  }
  if (areaM2(open) < 1) throw new RangeError('polygon has no area');
  return open;
}
