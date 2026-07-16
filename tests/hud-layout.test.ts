// @vitest-environment jsdom
//
// Regression test for the build-menu overflow fix in `src/renderer/hud.ts`.
//
// The full coastal roster is 14 entries at 36px each (504px), which is taller
// than the board band on short viewports. Pre-fix the menu was clamped to the
// viewport bottom and its last rows rendered under the bottom DOM chrome (which
// swallows clicks) or off-screen. Post-fix `buildMenuLayout` wraps the entries
// into columns so the whole rect stays inside the band. This test asserts every
// item rect is inside the band vertically, inside the viewport horizontally,
// and that no two item rects overlap.

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { createCanvasRenderer } from '../src/renderer/canvas';
import { BOARD_TOP_INSET, BOARD_BOTTOM_INSET } from '../src/renderer/canvas';
import type { BuildMenuEntry } from '../src/renderer/canvas';
import type { Coord } from '../src/engine/core/types';
import { __test } from '../src/renderer/hud';

function makeCtxStub(): CanvasRenderingContext2D {
  const noop = (): void => {};
  const stub: Record<string, unknown> = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    globalAlpha: 1,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    fillText: noop,
    setTransform: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
  };
  return stub as unknown as CanvasRenderingContext2D;
}

function makeRenderer() {
  const canvas = document.createElement('canvas');
  canvas.getContext = (type: string) =>
    (type === '2d' ? makeCtxStub() : null) as never;
  const renderer = createCanvasRenderer(canvas);
  renderer.resize();
  return renderer;
}

function make14Entries(): BuildMenuEntry[] {
  const entries: BuildMenuEntry[] = [];
  for (let i = 0; i < 14; i++) {
    entries.push({
      unitType: 'infantry',
      label: `Unit ${i}`,
      cost: 1000,
      affordable: true,
    });
  }
  return entries;
}

type Rect = { x: number; y: number; w: number; h: number };

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w &&
    b.x < a.x + a.w &&
    a.y < b.y + b.h &&
    b.y < a.y + a.h
  );
}

describe('buildMenuLayout wraps into columns and stays inside the board band', () => {
  beforeAll(() => {
    const orig = console.error.bind(console);
    console.error = (...args: unknown[]): void => {
      if (
        typeof args[0] === 'string' &&
        args[0].includes("HTMLCanvasElement's getContext")
      ) {
        return;
      }
      orig(...(args as []));
    };
  });

  beforeEach(() => {
    // 700px-tall viewport: 14 entries * 36px = 504px cannot fit the ~480px band.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true });
  });

  // Exercise a few anchor tiles, including ones that force the horizontal flip
  // and the bottom clamp, so the clamping is verified across placements.
  const tiles: Coord[] = [
    { x: 2, y: 2 },
    { x: 20, y: 13 },
    { x: 0, y: 0 },
  ];

  it.each(tiles)('every item rect is inside the band for tile %o', (tile) => {
    const renderer = makeRenderer();
    const vp = renderer.getViewport();
    const layout = __test.buildMenuLayout(renderer, { tile, entries: make14Entries() });

    expect(layout.items).toHaveLength(14);
    for (const item of layout.items) {
      // Inside the board band vertically.
      expect(item.y).toBeGreaterThanOrEqual(BOARD_TOP_INSET);
      expect(item.y + item.h).toBeLessThanOrEqual(vp.height - BOARD_BOTTOM_INSET);
      // Inside the viewport horizontally.
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x + item.w).toBeLessThanOrEqual(vp.width);
    }

    // Multi-column: the roster must not fit in a single column here.
    const cols = new Set(layout.items.map((i) => i.x)).size;
    expect(cols).toBeGreaterThan(1);

    // No two item rects overlap.
    for (let i = 0; i < layout.items.length; i++) {
      for (let j = i + 1; j < layout.items.length; j++) {
        expect(overlaps(layout.items[i]!, layout.items[j]!)).toBe(false);
      }
    }
  });
});
