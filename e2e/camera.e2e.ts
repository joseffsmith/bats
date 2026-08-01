// The mobile board camera, driven through `__bats.camera` in a real browser.
//
// tests/camera.test.ts already proves the geometry in node — the clamps, the
// zoom-about-a-focal-point invariant, the pan bounds — against a hand-fed map
// size and view size. What it cannot see is whether the camera the PAGE built
// is wired to the things it claims: the measured HUD/tray band, the renderer's
// hit-testing (`tileToScreen`), the overview button, and the touch gesture
// layer that is the only way a player actually pans or zooms.
//
// So the assertions here are all "wired correctly", expressed against numbers
// measured from the live DOM rather than assumed:
//
//   band  = [ HUD height , viewportHeight − tray height ]
//   fit   = min(viewWidth / cols, bandHeight / rows)     ← the zoom floor
//   clamp = grid fits the band → LOCKED centred; overflows → edges may not
//           cross inside the band
//
// The camera is also the hook's answer to "is this the mobile board" — it is
// spread into `__bats` only when one exists — so the desktop case asserts its
// ABSENCE rather than some desktop-flavoured behaviour.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { launchBrowser } from '../scripts/lib/browser-harness';
import type { BatsDebug } from '../src/renderer/debug-hook';
import {
  bats,
  expectNoConsoleErrors,
  historyTypes,
  inputState,
  MOBILE,
  MOBILE_W,
  newPage,
  openMap,
  settleFrames,
  state,
} from './helpers';

type BatsWindow = { __bats: BatsDebug };

/** Zoom ceiling + boot zoom from renderer/camera.ts, restated for the specs. */
const MAX_TILE_SIZE = 90;
const MIN_READABLE_TILE = 48;

type CameraView = { tileSize: number; origin: { x: number; y: number } };

function camera(page: Page): Promise<CameraView> {
  return bats<CameraView>(page, 'camera.get()');
}

/**
 * The band the board is clamped into, measured from the mounted shell — the
 * same two numbers main.ts forwards into `renderer.setBoardInsets` → the
 * camera's `setBand`. Read live so the spec never hard-codes a chrome height.
 */
async function geometry(page: Page): Promise<{
  vw: number;
  vh: number;
  bandTop: number;
  bandBottom: number;
  bandH: number;
  cols: number;
  rows: number;
}> {
  const dom = await page.evaluate(() => {
    const hud = document.querySelector<HTMLElement>('.mhud');
    const tray = document.querySelector<HTMLElement>('.tray');
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      top: Math.round(hud?.offsetHeight ?? 0),
      bottom: Math.round(tray?.offsetHeight ?? 0),
    };
  });
  const s = await state(page);
  const rows = s.map.length;
  const cols = s.map[0]!.length;
  return {
    vw: dom.vw,
    vh: dom.vh,
    bandTop: dom.top,
    bandBottom: dom.vh - dom.bottom,
    bandH: dom.vh - dom.top - dom.bottom,
    cols,
    rows,
  };
}

/** Where the camera is allowed to put the grid's top-left, per axis. */
function clampBounds(
  g: Awaited<ReturnType<typeof geometry>>,
  tileSize: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const gridW = g.cols * tileSize;
  const gridH = g.rows * tileSize;
  return {
    minX: gridW <= g.vw ? (g.vw - gridW) / 2 : g.vw - gridW,
    maxX: gridW <= g.vw ? (g.vw - gridW) / 2 : 0,
    minY: gridH <= g.bandH ? g.bandTop + (g.bandH - gridH) / 2 : g.bandBottom - gridH,
    maxY: gridH <= g.bandH ? g.bandTop + (g.bandH - gridH) / 2 : g.bandTop,
  };
}

/** Single-finger drag. Real touch events, so this exercises gestures.ts →
 *  `camera.panBy` exactly as a thumb does — not the camera API directly. */
async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8,
): Promise<void> {
  await page.touchscreen.touchStart(from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.touchscreen.touchMove(
      from.x + (to.x - from.x) * t,
      from.y + (to.y - from.y) * t,
    );
  }
  await page.touchscreen.touchEnd();
}

describe('mobile board camera', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('boots at a readable tactical zoom inside its own clamp band', async () => {
    const page = await newPage(browser);
    try {
      const captured = await openMap(page, { map: 'duel', ...MOBILE });
      const cam = await camera(page);
      const g = await geometry(page);

      // Thumb-sized and readable, never past the ceiling.
      expect(cam.tileSize).toBeGreaterThanOrEqual(MIN_READABLE_TILE);
      expect(cam.tileSize).toBeLessThanOrEqual(MAX_TILE_SIZE);
      // Full-bleed by design: 12 columns at that zoom overflow a 390px phone,
      // so the board is pannable rather than shrunk until it fits.
      expect(g.cols * cam.tileSize).toBeGreaterThan(MOBILE_W);

      // The origin is integer-rounded (the renderer's 0.5px hairlines only land
      // on a physical pixel when it is) and inside the clamp.
      expect(Number.isInteger(cam.origin.x)).toBe(true);
      expect(Number.isInteger(cam.origin.y)).toBe(true);
      const b = clampBounds(g, cam.tileSize);
      expect(cam.origin.x).toBeGreaterThanOrEqual(Math.floor(b.minX));
      expect(cam.origin.x).toBeLessThanOrEqual(Math.ceil(b.maxX));
      expect(cam.origin.y).toBeGreaterThanOrEqual(Math.floor(b.minY));
      expect(cam.origin.y).toBeLessThanOrEqual(Math.ceil(b.maxY));

      expectNoConsoleErrors(captured);
    } finally {
      await page.close();
    }
  });

  it('toggleOverview fits the whole board, and toggling back restores the zoom', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });
      const before = await camera(page);
      const g = await geometry(page);
      const fit = Math.min(g.vw / g.cols, g.bandH / g.rows);

      await bats(page, 'camera.toggleOverview()');
      await settleFrames(page, 2);

      const overview = await camera(page);
      expect(overview.tileSize).toBeLessThan(before.tileSize);
      expect(overview.tileSize).toBeCloseTo(fit, 1);
      // "Everything is reachable" made literal: at the overview zoom every
      // corner of the map is inside the band, not merely inside the viewport.
      for (const corner of [
        { x: 0, y: 0 },
        { x: g.cols - 1, y: 0 },
        { x: 0, y: g.rows - 1 },
        { x: g.cols - 1, y: g.rows - 1 },
      ]) {
        const p = await bats<{ x: number; y: number }>(
          page,
          `tileToScreen({x:${corner.x},y:${corner.y}})`,
        );
        expect(p.x, `corner ${corner.x},${corner.y} x`).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(g.vw);
        expect(p.y, `corner ${corner.x},${corner.y} y`).toBeGreaterThanOrEqual(g.bandTop);
        expect(p.y).toBeLessThanOrEqual(g.bandBottom);
      }

      // Round trip: back to the tactical zoom the player was last at.
      await bats(page, 'camera.toggleOverview()');
      await settleFrames(page, 2);
      expect((await camera(page)).tileSize).toBe(before.tileSize);
    } finally {
      await page.close();
    }
  });

  it('centerOn pulls a far corner into the visible band', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });
      const g = await geometry(page);

      // Both diagonal extremes, one after the other: the first is only
      // reachable by panning right to the clamp, the second by panning back.
      for (const corner of [
        { x: g.cols - 1, y: g.rows - 1 },
        { x: 0, y: 0 },
      ]) {
        await bats(page, `camera.centerOn({x:${corner.x},y:${corner.y}})`);
        await settleFrames(page, 2);
        const p = await bats<{ x: number; y: number }>(
          page,
          `tileToScreen({x:${corner.x},y:${corner.y}})`,
        );
        expect(p.x, `corner ${corner.x},${corner.y} x in view`).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(g.vw);
        expect(p.y, `corner ${corner.x},${corner.y} y in band`).toBeGreaterThanOrEqual(
          g.bandTop,
        );
        expect(p.y).toBeLessThanOrEqual(g.bandBottom);

        // …and the clamp still holds after being asked for the impossible.
        const cam = await camera(page);
        const b = clampBounds(g, cam.tileSize);
        expect(cam.origin.x).toBeGreaterThanOrEqual(Math.floor(b.minX));
        expect(cam.origin.x).toBeLessThanOrEqual(Math.ceil(b.maxX));
        expect(cam.origin.y).toBeGreaterThanOrEqual(Math.floor(b.minY));
        expect(cam.origin.y).toBeLessThanOrEqual(Math.ceil(b.maxY));
      }
    } finally {
      await page.close();
    }
  });

  it('setZoom is clamped to the fit floor and the 90px ceiling', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });
      const g = await geometry(page);
      const fit = Math.min(g.vw / g.cols, g.bandH / g.rows);

      await bats(page, 'camera.setZoom(1000)');
      await settleFrames(page, 2);
      expect((await camera(page)).tileSize).toBe(MAX_TILE_SIZE);

      // The floor is "the whole map fits", never further out than that.
      await bats(page, 'camera.setZoom(1)');
      await settleFrames(page, 2);
      const floored = await camera(page);
      expect(floored.tileSize).toBeCloseTo(fit, 1);
      expect(g.cols * floored.tileSize).toBeLessThanOrEqual(g.vw + 1);
      expect(g.rows * floored.tileSize).toBeLessThanOrEqual(g.bandH + 1);

      // fitMap is that same zoom by another name.
      await bats(page, 'camera.setZoom(70)');
      await bats(page, 'camera.fitMap()');
      await settleFrames(page, 2);
      expect((await camera(page)).tileSize).toBeCloseTo(floored.tileSize, 5);
    } finally {
      await page.close();
    }
  });

  it('a long drag pans to the clamp, never past it, and never becomes a tap', async () => {
    const page = await newPage(browser);
    try {
      const captured = await openMap(page, { map: 'duel', ...MOBILE });
      const g = await geometry(page);
      const start = await camera(page);
      const bounds = clampBounds(g, start.tileSize);
      // The scenario only means something if the board overflows horizontally
      // and fits vertically — which is exactly duel on a 390×844 phone.
      expect(g.cols * start.tileSize).toBeGreaterThan(g.vw);
      expect(g.rows * start.tileSize).toBeLessThanOrEqual(g.bandH);

      const midY = Math.round(g.bandTop + (g.bandBottom - g.bandTop) / 2);
      // Drag left, well past the board's right edge, until it rests on the
      // clamp. Chromium coalesces touchmove, so this is a bounded loop rather
      // than one heroic swipe — it exits the moment the bound is reached.
      for (let i = 0; i < 6; i++) {
        const cam = await camera(page);
        if (cam.origin.x <= Math.round(bounds.minX)) break;
        await touchDrag(page, { x: g.vw - 40, y: midY }, { x: 40, y: midY });
        await settleFrames(page, 2);
      }

      const panned = await camera(page);
      expect(panned.origin.x, 'the drag moved the board').toBeLessThan(start.origin.x);
      expect(panned.origin.x, 'never past the clamp').toBeGreaterThanOrEqual(
        Math.round(bounds.minX),
      );
      expect(panned.origin.x, 'resting on the clamp').toBe(Math.round(bounds.minX));
      // Vertically the grid fits the band, so the position is LOCKED centred:
      // a diagonal drag cannot slide a short board off-centre.
      expect(panned.origin.y).toBe(Math.round(bounds.minY));
      expect(panned.tileSize).toBe(start.tileSize);

      // Drag back the other way and the opposite bound holds.
      for (let i = 0; i < 6; i++) {
        const cam = await camera(page);
        if (cam.origin.x >= Math.round(bounds.maxX)) break;
        await touchDrag(page, { x: 40, y: midY }, { x: g.vw - 40, y: midY });
        await settleFrames(page, 2);
      }
      expect((await camera(page)).origin.x).toBe(Math.round(bounds.maxX));

      // A gesture is never a tap: gestures.ts preventDefaults the touchend, so
      // no synthetic click ever reached the input machine.
      expect((await inputState(page)).kind).toBe('idle');
      expect(await historyTypes(page)).toEqual([]);
      expectNoConsoleErrors(captured);
    } finally {
      await page.close();
    }
  });

  it('a two-finger pinch zooms the board in and settles on a whole pixel', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });
      const before = await camera(page);
      const g = await geometry(page);
      const midY = Math.round(g.bandTop + (g.bandBottom - g.bandTop) / 2);

      // Multi-touch is below puppeteer's Touchscreen API (single touch only),
      // so this is the one place a spec talks raw CDP. Fingers spread 100px →
      // 200px, i.e. a 2× zoom request that the ceiling then clamps.
      const cdp = await page.createCDPSession();
      try {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [
            { x: g.vw / 2 - 50, y: midY },
            { x: g.vw / 2 + 50, y: midY },
          ],
        });
        for (const spread of [70, 90, 100]) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [
              { x: g.vw / 2 - spread, y: midY },
              { x: g.vw / 2 + spread, y: midY },
            ],
          });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } finally {
        await cdp.detach();
      }

      await page.waitForFunction(
        (t0: number) =>
          ((window as unknown as BatsWindow).__bats.camera?.get().tileSize ?? 0) > t0,
        { timeout: 10_000, polling: 50 },
        before.tileSize,
      );

      const after = await camera(page);
      expect(after.tileSize).toBeLessThanOrEqual(MAX_TILE_SIZE);
      // Fingers off the glass → `settle()` rounds the tile size back to an
      // integer so the renderer's hairlines land on real pixels again.
      expect(Number.isInteger(after.tileSize)).toBe(true);
      // And a pinch is not a tap either.
      expect((await inputState(page)).kind).toBe('idle');
      expect(await historyTypes(page)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('is absent on desktop — the hook is how a driver feature-detects the board', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel' });
      const hasCamera = await page.evaluate(
        () => (window as unknown as BatsWindow).__bats.camera !== undefined,
      );
      expect(hasCamera, 'desktop fits the whole board itself — no camera').toBe(false);
    } finally {
      await page.close();
    }
  });
});
