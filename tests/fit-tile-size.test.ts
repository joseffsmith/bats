// Unit tests for `fitTileSize` — the pure fit-to-viewport tile scaler that
// replaced the old width-threshold step (TILE_SIZE_MOBILE / MOBILE_BREAKPOINT).
//
// Node env (no DOM): the function is arithmetic over cols/rows/viewport/insets.
//   availW = width  - 2*MARGIN(12)
//   availH = height - insetTop - insetBottom - 2*MARGIN
//   fit    = floor(min(availW/cols, availH/rows))
//   fit>=32 → snap DOWN to the nearest multiple of 16; final clamp [16, 64].

import { describe, expect, it } from 'vitest';
import { fitTileSize } from '../src/renderer/canvas';

describe('fitTileSize', () => {
  it('armada (20x12) on a 390x844 phone with 170/90 insets fits ~18px', () => {
    // availW = 366 → 366/20 = 18.3 (width-bound); availH = 560 → 560/12 = 46.7.
    // fit = floor(18.3) = 18; below 32 so no snap; clamp keeps 18.
    expect(fitTileSize(20, 12, 390, 844, 170, 90)).toBe(18);
  });

  it('duel (12x8) on a 1280x900 desktop caps at 64', () => {
    // availH = 656 → 656/8 = 82 (height-bound); floor(82)=82 → snap to 80 →
    // clamp to the 64 ceiling.
    expect(fitTileSize(12, 8, 1280, 900, 110, 110)).toBe(64);
  });

  it('snaps a 47px raw fit down to the nearest multiple of 16 (32)', () => {
    // 10x10 grid, availW = 475 → 47.5, availH = 500 → 50. fit = floor(47.5) = 47;
    // 47 >= 32 so snap: floor(47/16)*16 = 32.
    expect(fitTileSize(10, 10, 499, 524, 0, 0)).toBe(32);
  });

  it('clamps up to the 16px floor on a tiny viewport', () => {
    // availW = 176 → 8.8, availH = 76 → 6.3. fit = 6; below 32 (no snap); the
    // [16,64] clamp raises it to 16 so the board never vanishes.
    expect(fitTileSize(20, 12, 200, 200, 50, 50)).toBe(16);
  });

  it('is defensive against a degenerate (0-column) map', () => {
    expect(fitTileSize(0, 0, 1280, 900, 110, 110)).toBeGreaterThan(0);
  });
});
