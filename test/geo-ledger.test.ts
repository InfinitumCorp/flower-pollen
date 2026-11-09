import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidCell, getResolution } from 'h3-js';
import { coverageCells, h3ResolutionFor, haversineM, normalizeRing, pointInRing, type Ring } from '../src/geo.ts';
import { openDb, tx } from '../src/db.ts';
import { record, verify } from '../src/ledger.ts';

// ~1 km square near 0,0
const square: Ring = [[0, 0], [0.009, 0], [0.009, 0.009], [0, 0.009]];

test('pointInRing', () => {
  assert.equal(pointInRing([0.004, 0.004], square), true);
  assert.equal(pointInRing([0.02, 0.004], square), false);
});

test('haversine ~1 km per 0.009° at equator', () => {
  const d = haversineM([0, 0], [0.009, 0]);
  assert.ok(d > 990 && d < 1010, `got ${d}`);
});

test('h3ResolutionFor picks the hexagon size nearest the requested cell size', () => {
  assert.equal(h3ResolutionFor(120), 10); // global average: res 10 ≈ 123 m
  assert.equal(h3ResolutionFor(45), 11);  // res 11 ≈ 46 m
  assert.equal(h3ResolutionFor(1), 13);   // clamped
  assert.equal(h3ResolutionFor(106, [0.0045, 0.0045]), 10); // res 10 cells near 0,0 are ≈ 106 m
});

test('coverageCells tiles the area with H3 hexagons and excludes no-go zones', () => {
  const { res, cells: all } = coverageCells(square, [], 100);
  assert.equal(res, 10);
  // ~997,000 m² / ~11,200 m² per res-10 hexagon at this location ≈ 89
  assert.ok(all.length >= 80 && all.length <= 98, `got ${all.length}`);
  assert.ok(all.every((c) => isValidCell(c.h3) && getResolution(c.h3) === 10));
  assert.equal(new Set(all.map((c) => c.h3)).size, all.length);
  assert.deepEqual(all.map((c) => c.id), all.map((_, i) => i));

  const noGo: Ring = [[0, 0], [0.0045, 0], [0.0045, 0.0045], [0, 0.0045]]; // one quarter
  const { cells: some } = coverageCells(square, [noGo], 100);
  assert.ok(Math.abs(some.length - all.length * 0.75) <= 6, `got ${some.length} of ${all.length}`);
  assert.ok(some.every((c) => !pointInRing(c.center, noGo)));
});

test('coverageCells refuses oversized plans', () => {
  assert.throws(() => coverageCells([[0, 0], [1, 0], [1, 1], [0, 1]], [], 10), RangeError);
});

test('normalizeRing strips closing vertex and rejects degenerate polygons', () => {
  assert.equal(normalizeRing([...square, square[0]]).length, 4);
  assert.throws(() => normalizeRing([[0, 0], [1, 1], [2, 2]]), /no area/);
});

test('ledger is hash-chained, append-only and detects tampering', () => {
  const db = openDb();
  tx(db, () => { record(db, 'a', 'x', { n: 1 }); record(db, 'a', 'y', { n: 2 }); });
  const v = verify(db);
  assert.equal(v.ok, true);
  assert.throws(() => db.exec(`UPDATE ledger SET payload = '{"n":9}' WHERE seq = 1`), /append-only/);
  assert.throws(() => db.exec('DELETE FROM ledger'), /append-only/);
  // Bypass the triggers to simulate an out-of-band edit and confirm verification catches it.
  db.exec('DROP TRIGGER ledger_no_update');
  db.exec(`UPDATE ledger SET payload = '{"n":9}' WHERE seq = 1`);
  assert.deepEqual(verify(db), { ok: false, brokenAt: 1 });
});
