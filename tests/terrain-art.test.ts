// Pure-data guards for the hand-authored terrain tiles (Phase 3B). No canvas —
// runs in the node env, mirroring pixel-art.test.ts. The bars:
//
//   • structural — 16×16, only known terrain chars (dimension + palette closure);
//   • full-bleed — every cell opaque (zero '.' pixels), so tiles butt edge to
//     edge with no gutter;
//   • seam-safe — the outer ring of every tile is a single uniform char, so a
//     block of identical tiles (plain/sea/road especially) seams invisibly;
//   • ownership — city/hq/factory carry team-ramp cells (so their per-owner
//     bakes differ from the neutral bake); every other terrain carries none (so
//     it bakes once, owner-independent).

import { describe, expect, it } from 'vitest';
import { TERRAIN_GRIDS, OWNED_TERRAIN } from '../src/renderer/assets/pixel-art/terrain/index';
import { isKnownTerrainChar } from '../src/renderer/assets/pixel-art/terrain/palette';
import {
  validateGridWith,
  opaquePixelCount,
  distinctChars,
  teamPixelRatio,
} from '../src/renderer/assets/pixel-art/validate';
import type { TerrainType } from '../src/engine/core/types';

const TYPES = Object.keys(TERRAIN_GRIDS) as TerrainType[];
const N = 16;

/** The four-edge border chars of a grid (top row, bottom row, both columns). */
function borderChars(grid: string[]): Set<string> {
  const s = new Set<string>();
  for (let x = 0; x < N; x++) {
    s.add(grid[0]![x]!);
    s.add(grid[N - 1]![x]!);
  }
  for (let y = 0; y < N; y++) {
    s.add(grid[y]![0]!);
    s.add(grid[y]![N - 1]!);
  }
  return s;
}

describe('terrain-art: structure', () => {
  it('covers all 8 terrain types', () => {
    expect(TYPES).toHaveLength(8);
  });

  it.each(TYPES)('%s is a valid 16×16 grid of known terrain chars', (type) => {
    expect(validateGridWith(type, TERRAIN_GRIDS[type], isKnownTerrainChar)).toEqual([]);
  });

  it.each(TYPES)('%s is full-bleed (every cell opaque, no "." pixels)', (type) => {
    expect(opaquePixelCount(TERRAIN_GRIDS[type])).toBe(N * N);
  });

  it.each(TYPES)('%s uses ≥3 distinct chars', (type) => {
    expect(distinctChars(TERRAIN_GRIDS[type]).size).toBeGreaterThanOrEqual(3);
  });
});

describe('terrain-art: seam-safe borders', () => {
  it.each(TYPES)('%s has a uniform outer ring so identical tiles seam cleanly', (type) => {
    // A single border char means the top/bottom/left/right edges all match, so
    // two adjacent copies of the tile meet on the same colour — no grid line.
    expect(borderChars(TERRAIN_GRIDS[type]).size).toBe(1);
  });
});

describe('terrain-art: ownership', () => {
  it.each(TYPES)('%s carries team cells iff it is capturable', (type) => {
    const ratio = teamPixelRatio(TERRAIN_GRIDS[type]);
    if (OWNED_TERRAIN.has(type)) {
      // Team-ramp accent present → the per-owner bakes differ from the neutral
      // (steel-ramp) bake. Kept a legible-but-restrained share of the tile.
      expect(ratio, `${type} should have a team accent`).toBeGreaterThan(0.03);
      expect(ratio, `${type} team accent should stay an accent`).toBeLessThan(0.35);
    } else {
      // Owner-independent terrain must bake once — no team cells at all.
      expect(ratio, `${type} must not vary by owner`).toBe(0);
    }
  });

  it('city, hq and factory are the only capturable terrains', () => {
    expect([...OWNED_TERRAIN].sort()).toEqual(['city', 'factory', 'hq']);
  });
});
