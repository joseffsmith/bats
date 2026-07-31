// Unit tests for the mobile board camera (src/renderer/camera.ts).
//
// Node env, no DOM: the camera takes its map size and view size through `deps`
// and its clock through `tick(nowMs)`, precisely so its geometry can be pinned
// down here rather than only observed through a browser.
//
// Reference scenario throughout: the `duel` map (12×8) on a 390×844 phone with
// the measured chrome insets (170 top / 90 bottom), i.e. a 390×584 band.
//
//   fit  = min(390/12, 584/8) = min(32.5, 73) = 32.5   ← the zoom floor
//   boot = max(fit, 56) = 56                            ← tactical, not fitted
//   grid at 56 = 672×448 → wider than the band, shorter than it

import { describe, expect, it } from 'vitest';
import { createCamera, BOOT_TILE_SIZE, MAX_TILE_SIZE } from '../src/renderer/camera';
import type { Camera, CameraDeps } from '../src/renderer/camera';

const VIEW_W = 390;
const VIEW_H = 844;
const INSET_TOP = 170;
const INSET_BOTTOM = 90;
const BAND_H = VIEW_H - INSET_TOP - INSET_BOTTOM; // 584

type Harness = {
  camera: Camera;
  setMap(cols: number, rows: number): void;
  setView(width: number, height: number): void;
};

function harness(
  opts: {
    cols?: number;
    rows?: number;
    width?: number;
    height?: number;
    focus?: { x: number; y: number } | null;
    band?: [number, number];
  } = {},
): Harness {
  let size = { cols: opts.cols ?? 12, rows: opts.rows ?? 8 };
  let view = { width: opts.width ?? VIEW_W, height: opts.height ?? VIEW_H };
  const focus = opts.focus ?? null;
  const deps: CameraDeps = {
    getMapSize: () => size,
    getViewSize: () => view,
    ...(opts.focus !== undefined ? { getInitialFocus: (): { x: number; y: number } | null => focus } : {}),
  };
  const camera = createCamera(deps);
  const [top, bottom] = opts.band ?? [INSET_TOP, INSET_BOTTOM];
  camera.setBand(top, bottom);
  return {
    camera,
    setMap: (cols, rows) => {
      size = { cols, rows };
    },
    setView: (width, height) => {
      view = { width, height };
    },
  };
}

/** The tile-space point currently painted at CSS-px point (px, py). */
function worldAt(camera: Camera, px: number, py: number): { x: number; y: number } {
  const ts = camera.tileSize();
  const o = camera.origin();
  return { x: (px - o.x) / ts, y: (py - o.y) / ts };
}

describe('camera boot', () => {
  it('boots at the tactical zoom, not the fitted one', () => {
    const { camera } = harness();
    // fit is 32.5 — unreadable on a phone. Boot must be the 56px tactical size.
    expect(camera.tileSize()).toBe(BOOT_TILE_SIZE);
    expect(camera.isOverview()).toBe(false);
  });

  it('boots centred on the supplied focus tile, clamped to the board edge', () => {
    // duel P0 HQ is (1,2): centring on it would want origin.x = 195 - 84 = 111,
    // which would leave dead space left of the board, so the clamp pins it to 0.
    const { camera } = harness({ focus: { x: 1, y: 2 } });
    expect(camera.origin().x).toBe(0);
    // 448px of grid inside a 584px band → locked centred, ignoring the focus.
    expect(camera.origin().y).toBe(INSET_TOP + Math.round((BAND_H - 8 * 56) / 2));
  });

  it('boots at the fit size when the map already fits above the tactical size', () => {
    // A 4×4 map in a 390×584 band fits at 97.5px, above the 90px ceiling, so the
    // floor and the ceiling coincide and boot lands on the ceiling.
    const { camera } = harness({ cols: 4, rows: 4 });
    expect(camera.tileSize()).toBe(MAX_TILE_SIZE);
    expect(camera.isOverview()).toBe(true);
  });
});

describe('camera zoom clamps', () => {
  it('refuses to zoom out past the whole map (full-bleed, no margin)', () => {
    const { camera } = harness();
    camera.setZoom(4);
    expect(camera.tileSize()).toBeCloseTo(390 / 12, 6); // 32.5, the fit size
    expect(camera.isOverview()).toBe(true);
  });

  it('refuses to zoom in past the ceiling', () => {
    const { camera } = harness();
    camera.setZoom(500);
    expect(camera.tileSize()).toBe(MAX_TILE_SIZE);
  });

  it('respects the band: a taller reserved chrome raises the zoom floor', () => {
    // Band 584 tall → the height term is 73, so width binds at 32.5. Squeeze the
    // band to 240 and the height term (30) binds instead.
    const wide = harness({ cols: 8, rows: 8 });
    wide.camera.setZoom(1);
    expect(wide.camera.tileSize()).toBeCloseTo(Math.min(390 / 8, BAND_H / 8), 6);

    const tight = harness({ cols: 8, rows: 8, band: [500, 104] });
    tight.camera.setZoom(1);
    expect(tight.camera.tileSize()).toBeCloseTo(240 / 8, 6);
  });
});

describe('camera zoom about a focal point', () => {
  it('keeps the world point under the focus pinned across a zoom', () => {
    const { camera } = harness();
    const focus = { x: 300, y: 500 };
    const before = worldAt(camera, focus.x, focus.y);
    camera.setZoom(80, focus);
    const after = worldAt(camera, focus.x, focus.y);
    // origin() is integer-rounded for crisp hairlines, so allow sub-pixel slack.
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  });

  it('holds the invariant across a zoom-out too, while the pan clamp allows it', () => {
    const { camera } = harness({ cols: 30, rows: 30 });
    const focus = { x: 120, y: 400 };
    const before = worldAt(camera, focus.x, focus.y);
    camera.setZoom(40, focus);
    const after = worldAt(camera, focus.x, focus.y);
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  });

  it('defaults the focal point to the band centre', () => {
    const { camera } = harness({ cols: 30, rows: 30 });
    const centre = { x: VIEW_W / 2, y: INSET_TOP + BAND_H / 2 };
    const before = worldAt(camera, centre.x, centre.y);
    camera.setZoom(75);
    const after = worldAt(camera, centre.x, centre.y);
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
  });
});

describe('camera pan clamp', () => {
  it('locks an axis centred when the grid fits inside the band', () => {
    const { camera } = harness(); // 8 rows × 56 = 448 < 584
    const y0 = camera.origin().y;
    camera.panBy(0, -400);
    expect(camera.origin().y).toBe(y0);
    camera.panBy(0, 400);
    expect(camera.origin().y).toBe(y0);
  });

  it('never lets the board edge cross inside the band on an overflowing axis', () => {
    const { camera } = harness(); // 12 cols × 56 = 672 > 390
    camera.panBy(9999, 0);
    // Left edge of the board can reach the left edge of the band, no further.
    expect(camera.origin().x).toBe(0);
    camera.panBy(-9999, 0);
    // Right edge of the board can reach the right edge of the band, no further.
    expect(camera.origin().x).toBe(VIEW_W - 12 * 56);
  });

  it('clamps both axes independently', () => {
    const { camera } = harness({ cols: 20, rows: 12 }); // 1120×672, both overflow
    camera.panBy(-9999, -9999);
    expect(camera.origin().x).toBe(VIEW_W - 20 * 56);
    // Bottom edge of the board reaches the band's bottom (view height - inset).
    expect(camera.origin().y).toBe(VIEW_H - INSET_BOTTOM - 12 * 56);
  });

  it('re-clamps when the map shrinks under it', () => {
    const h = harness({ cols: 20, rows: 12 });
    h.camera.panBy(-9999, -9999);
    // Scenario injection swaps in a small map; the next tick must re-clamp
    // rather than leave the camera parked over empty space.
    h.setMap(6, 6);
    h.camera.tick(0);
    const ts = h.camera.tileSize();
    expect(ts).toBeCloseTo(390 / 6, 6); // the 6×6 fit floor (65) now exceeds 56
    expect(h.camera.origin().x).toBe(0); // 390px of grid in a 390px band → centred
  });
});

describe('camera fit + overview', () => {
  it('fitMap shows the whole map inside the band', () => {
    const { camera } = harness({ cols: 20, rows: 12 });
    camera.fitMap();
    const ts = camera.tileSize();
    const o = camera.origin();
    expect(ts).toBeCloseTo(Math.min(VIEW_W / 20, BAND_H / 12), 6);
    expect(o.x).toBeGreaterThanOrEqual(0);
    expect(o.y).toBeGreaterThanOrEqual(INSET_TOP - 1);
    expect(o.x + 20 * ts).toBeLessThanOrEqual(VIEW_W + 1);
    expect(o.y + 12 * ts).toBeLessThanOrEqual(VIEW_H - INSET_BOTTOM + 1);
    expect(camera.isOverview()).toBe(true);
  });

  it('toggleOverview round-trips back to the tactical zoom', () => {
    const { camera } = harness();
    camera.setZoom(72);
    const tactical = camera.tileSize();
    expect(camera.isOverview()).toBe(false);

    camera.toggleOverview();
    expect(camera.isOverview()).toBe(true);
    expect(camera.tileSize()).toBeCloseTo(390 / 12, 6);

    camera.toggleOverview();
    expect(camera.isOverview()).toBe(false);
    expect(camera.tileSize()).toBeCloseTo(tactical, 6);
  });
});

describe('camera integer settle', () => {
  it('rounds a mid-pinch float tile size to an integer', () => {
    const { camera } = harness();
    camera.setZoom(61.37);
    expect(camera.tileSize()).toBeCloseTo(61.37, 6); // float allowed mid-gesture
    camera.settle();
    expect(camera.tileSize()).toBe(61);
    expect(Number.isInteger(camera.tileSize())).toBe(true);
  });

  it('steps UP to an integer rather than being clamped back below the floor', () => {
    // At the 32.5 floor, rounding to 32 would be clamped straight back to 32.5.
    const { camera } = harness();
    camera.setZoom(1); // pinned to the 32.5 fit floor
    camera.settle();
    expect(camera.tileSize()).toBe(33);
  });

  it('keeps the origin integral so 0.5px hairlines land on pixels', () => {
    const { camera } = harness({ cols: 20, rows: 12 });
    camera.setZoom(57.31, { x: 111, y: 333 });
    const o = camera.origin();
    expect(Number.isInteger(o.x)).toBe(true);
    expect(Number.isInteger(o.y)).toBe(true);
  });
});

describe('camera centerOn', () => {
  it('centres the band on a tile immediately when not animating', () => {
    const { camera } = harness({ cols: 20, rows: 12 });
    camera.centerOn({ x: 10, y: 6 });
    const ts = camera.tileSize();
    const o = camera.origin();
    expect(o.x + (10 + 0.5) * ts).toBeCloseTo(VIEW_W / 2, 0);
    expect(o.y + (6 + 0.5) * ts).toBeCloseTo(INSET_TOP + BAND_H / 2, 0);
  });

  it('eases over ~250ms when animating, and lands on the same target', () => {
    const { camera } = harness({ cols: 20, rows: 12 });
    camera.centerOn({ x: 1, y: 1 });
    const from = camera.origin();
    camera.centerOn({ x: 18, y: 10 }, true);
    // The tween is stamped by the first tick, so nothing has moved yet.
    camera.tick(1000);
    expect(camera.origin()).toEqual(from);
    camera.tick(1125); // halfway
    const mid = camera.origin();
    expect(mid.x).not.toBe(from.x);
    camera.tick(1250); // done
    const settled = camera.origin();

    const expected = harness({ cols: 20, rows: 12 });
    expected.camera.centerOn({ x: 18, y: 10 });
    expect(settled).toEqual(expected.camera.origin());

    // And it stops: further ticks don't drift.
    camera.tick(5000);
    expect(camera.origin()).toEqual(settled);
  });

  it('a manual pan cancels an in-flight auto-follow', () => {
    const { camera } = harness({ cols: 20, rows: 12 });
    camera.centerOn({ x: 18, y: 10 }, true);
    camera.tick(0);
    camera.panBy(-10, 0);
    const afterPan = camera.origin();
    camera.tick(500);
    expect(camera.origin()).toEqual(afterPan);
  });
});

describe('camera resize', () => {
  it('re-clamps zoom and pan against the new view size', () => {
    const h = harness({ cols: 12, rows: 8 });
    h.camera.panBy(-9999, 0);
    expect(h.camera.origin().x).toBe(VIEW_W - 12 * 56);
    // Rotate to landscape: 844×390. The grid (672) now fits the width, so the
    // x axis locks centred; the band shrinks vertically so the floor rises.
    h.setView(844, 390);
    h.camera.resize();
    expect(h.camera.origin().x).toBe(Math.round((844 - 12 * h.camera.tileSize()) / 2));
  });

  it('is inert before boot, so an early resize cannot lock in a stale band', () => {
    const h = harness({ band: [0, 0] });
    h.camera.resize();
    h.camera.setBand(INSET_TOP, INSET_BOTTOM);
    // First read boots against the CORRECTED band, not the one resize() saw.
    expect(h.camera.tileSize()).toBe(BOOT_TILE_SIZE);
    expect(h.camera.origin().y).toBe(INSET_TOP + Math.round((BAND_H - 8 * 56) / 2));
  });
});
