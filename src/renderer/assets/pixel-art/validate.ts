// Pure validators + silhouette metrics for the pixel-art grids.
//
// No canvas, no DOM — these run in the node unit environment (see
// tests/pixel-art.test.ts) and are the guard rail that keeps the authored art
// honest: right dimensions, only known chars, enough team colour to read as
// "whose unit is this", and silhouettes distinct enough to tell the roster
// apart at a glance. The bake pipeline trusts grids that pass these.

import { GRID_SIZE, type PixelGrid } from './types';
import { TEAM_CHARS, TRANSPARENT, isKnownChar } from './palette';

/** A boolean opacity mask: `mask[y][x]` true where the cell is not '.'. */
export type Silhouette = boolean[][];

/**
 * Structural check against an arbitrary "known char" predicate. Returns a list
 * of human-readable problems; empty = valid. `name` is threaded into each
 * message so a failing test names the grid. Shared by the unit sprites
 * (`validateGrid`, via `isKnownChar`) and the terrain tiles (via
 * `isKnownTerrainChar`), so both palettes go through the same dimension check.
 */
export function validateGridWith(
  name: string,
  grid: PixelGrid,
  known: (ch: string) => boolean,
): string[] {
  const errors: string[] = [];
  if (grid.length !== GRID_SIZE) {
    errors.push(`${name}: expected ${GRID_SIZE} rows, got ${grid.length}`);
  }
  grid.forEach((row, y) => {
    if (row.length !== GRID_SIZE) {
      errors.push(`${name}: row ${y} has ${row.length} chars, expected ${GRID_SIZE}`);
    }
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      if (!known(ch)) {
        errors.push(`${name}: unknown char '${ch}' at (${x},${y})`);
      }
    }
  });
  return errors;
}

/**
 * Structural check for the unit sprites: 16×16 of `FIXED_PALETTE ∪ {A–D, '.'}`.
 */
export function validateGrid(name: string, grid: PixelGrid): string[] {
  return validateGridWith(name, grid, isKnownChar);
}

/** Count of non-transparent cells. */
export function opaquePixelCount(grid: PixelGrid): number {
  let n = 0;
  for (const row of grid) {
    for (const ch of row) if (ch !== TRANSPARENT) n += 1;
  }
  return n;
}

/**
 * Fraction of opaque pixels drawn from the team ramp (A/B/C/D). This is the
 * "reads as team-coloured" bar: Advance-Wars units are mostly their army's
 * colour, so we require a healthy share (see tests for the threshold).
 */
export function teamPixelRatio(grid: PixelGrid): number {
  const opaque = opaquePixelCount(grid);
  if (opaque === 0) return 0;
  let team = 0;
  const teamSet = new Set<string>(TEAM_CHARS);
  for (const row of grid) {
    for (const ch of row) if (teamSet.has(ch)) team += 1;
  }
  return team / opaque;
}

/** The set of distinct non-transparent chars (guards against flat blobs). */
export function distinctChars(grid: PixelGrid): Set<string> {
  const s = new Set<string>();
  for (const row of grid) {
    for (const ch of row) if (ch !== TRANSPARENT) s.add(ch);
  }
  return s;
}

/** Boolean opacity mask for silhouette comparison. */
export function silhouette(grid: PixelGrid): Silhouette {
  return grid.map((row) => {
    const cells: boolean[] = [];
    for (let x = 0; x < GRID_SIZE; x++) cells.push((row[x] ?? TRANSPARENT) !== TRANSPARENT);
    return cells;
  });
}

/**
 * Hamming distance between two silhouettes: the number of cells opaque in one
 * but not the other. Higher = more distinguishable outlines. Used to enforce a
 * pairwise floor across the roster so no two units read as the same blob.
 */
export function silhouetteDistance(a: PixelGrid, b: PixelGrid): number {
  const sa = silhouette(a);
  const sb = silhouette(b);
  let d = 0;
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      if (sa[y]![x] !== sb[y]![x]) d += 1;
    }
  }
  return d;
}
