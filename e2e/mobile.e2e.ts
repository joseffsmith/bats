// Mobile / touch flows on an iPhone-13-ish emulated viewport (390×844, touch).
// Covers the Phase 2.3/2.5/2.6 mobile work: chrome fits the viewport, the DOM
// menus render as touch layouts (bottom sheet / action bar), the two-tap attack
// confirm, the floating Cancel chip — plus the camera board (Phase A): a
// tactical boot zoom and a reachable overview.
//
// Touch emulation is applied BEFORE navigation (helpers.openMap → setViewport)
// so the input controller reads `(pointer: coarse)` at construction and arms the
// two-tap path. The same media query is what puts the page in mobile mode, so
// every spec in this file exercises the camera + gesture board. Enemy taps go
// through `page.touchscreen.tap` — which is also the standing proof that the
// gesture layer leaves sub-threshold taps alone: they still arrive at the input
// controller as the browser's synthetic click.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'puppeteer';
import { launchBrowser } from '../scripts/lib/browser-harness';
import { createInitialState } from '../src/engine/core/initial-state';
import type { GameState } from '../src/engine/core/types';
import type { BatsDebug } from '../src/renderer/debug-hook';
import {
  awaitIdle,
  bats,
  clickMenuEntry,
  clickTile,
  inputState,
  newPage,
  openMap,
  setGameState,
  settleFrames,
  state,
} from './helpers';

type BatsWindow = { __bats: BatsDebug };

const W = 390;
const H = 844;
const MOBILE = { width: W, height: H, hasTouch: true, isMobile: true } as const;

/** Two infantry a tile apart on open plain, P0 to act (mirrors combat spec). */
function adjacencyScenario(): GameState {
  return createInitialState({
    width: 6,
    height: 6,
    hqs: [
      { owner: 0, pos: { x: 0, y: 0 } },
      { owner: 1, pos: { x: 5, y: 5 } },
    ],
    units: [
      { type: 'infantry', owner: 0, pos: { x: 2, y: 2 } },
      { type: 'infantry', owner: 1, pos: { x: 3, y: 2 } },
    ],
  });
}

describe('mobile / touch', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('End Turn button fits the viewport and both funds values are visible', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });

      const btn = await page.$('[data-action="end-turn"]');
      expect(btn, 'End Turn button should exist').toBeTruthy();
      const box = await btn!.boundingBox();
      expect(box, 'End Turn should have a layout box').toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(W);
      expect(box!.y + box!.height).toBeLessThanOrEqual(H);

      // Both players' coffer values: visible (in-viewport, non-zero size) with
      // non-empty "$…" text.
      const funds = await page.$$eval('.stat-coffer .v', (els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            text: (el.textContent ?? '').trim(),
            inView: r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= window.innerWidth,
          };
        }),
      );
      expect(funds).toHaveLength(2);
      for (const f of funds) {
        expect(f.inView, `funds "${f.text}" should be in-viewport`).toBe(true);
        expect(f.text.startsWith('$')).toBe(true);
      }
    } finally {
      await page.close();
    }
  });

  it('two-tap attack: first tap previews, second tap commits', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });

      const scenario = adjacencyScenario();
      const defenderId = Object.values(scenario.units).find((u) => u.owner === 1)!.id;
      await setGameState(page, scenario);

      // Select attacker → open action menu in place → tap Attack (touch action bar).
      await clickTile(page, { x: 2, y: 2 });
      await clickTile(page, { x: 2, y: 2 });
      await clickMenuEntry(page, 'Attack');
      expect((await inputState(page)).kind).toBe('attack-targeting');

      // First tap on the enemy: still targeting, hover set, NO damage yet.
      const tgt = await bats<{ x: number; y: number }>(page, 'tileToScreen({x:3,y:2})');
      await page.touchscreen.tap(tgt.x, tgt.y);
      await page.waitForFunction(
        () => {
          const s = (window as unknown as BatsWindow).__bats.input.getInputState();
          return s.kind === 'attack-targeting' && s.hover != null;
        },
        { timeout: 5000, polling: 50 },
      );
      expect((await state(page)).units[defenderId]!.hp).toBe(100);

      // Second tap on the SAME enemy commits the ATTACK.
      await page.touchscreen.tap(tgt.x, tgt.y);
      await awaitIdle(page);
      const after = await state(page);
      expect(after.units[defenderId]!.hp).toBeLessThan(100);
    } finally {
      await page.close();
    }
  });

  it('Cancel chip shows on selection and returns the input to idle', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });

      // Duel P0 infantry stands on (2,2). Select it.
      await clickTile(page, { x: 2, y: 2 });
      expect((await inputState(page)).kind).toBe('unit-selected');

      const chipVisible = await page.evaluate(() => {
        const el = document.querySelector('[data-action="cancel"]') as HTMLElement | null;
        return !!el && !el.hidden;
      });
      expect(chipVisible, 'cancel chip should be visible while a unit is selected').toBe(true);

      await page.click('[data-action="cancel"]');
      await page.waitForFunction(
        () => (window as unknown as BatsWindow).__bats.input.getInputState().kind === 'idle',
        { timeout: 5000, polling: 50 },
      );
      expect((await inputState(page)).kind).toBe('idle');
    } finally {
      await page.close();
    }
  });

  it('coastal build menu is a scrollable bottom sheet; the last entry builds', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'armada', ...MOBILE });

      // Fund P0 so every entry is affordable.
      const s = await state(page);
      s.players[0].funds = 99999;
      await setGameState(page, s);

      // P0 coastal factory is at (3,9).
      await clickTile(page, { x: 3, y: 9 });
      expect((await inputState(page)).kind).toBe('build-menu-open');

      const sheet = await page.evaluate(() => {
        const el = document.querySelector('.menu-sheet');
        const list = document.querySelector('.menu-build-list') as HTMLElement | null;
        return {
          hasSheet: !!el,
          entries: document.querySelectorAll('[data-build-entry]').length,
          scrolls: list ? list.scrollHeight > list.clientHeight : false,
        };
      });
      expect(sheet.hasSheet, 'build menu should render as a bottom sheet on touch').toBe(true);
      expect(sheet.entries).toBe(14);
      // The 14-entry roster overflows the capped sheet → it scrolls (the DOM
      // successor to the old canvas column-wrap regression: every entry reachable).
      expect(sheet.scrolls, 'the sheet must scroll to reach every entry').toBe(true);

      // Scroll to + build the LAST entry (carrier). clickMenuEntry auto-scrolls
      // the button into view before tapping.
      const lastType = await page.$$eval('[data-build-entry]', (els) =>
        els[els.length - 1]!.getAttribute('data-build-entry'),
      );
      await clickMenuEntry(page, lastType!);
      await awaitIdle(page);

      const after = await state(page);
      const built = Object.values(after.units).find(
        (u) => u.owner === 0 && u.pos.x === 3 && u.pos.y === 9,
      );
      expect(built, `a "${lastType}" should have been built on (3,9)`).toBeTruthy();
    } finally {
      await page.close();
    }
  });

  // The mobile board is camera-driven: it boots at a TACTICAL zoom (readable,
  // thumb-sized tiles) and deliberately runs past the screen edges, which is the
  // opposite of the old "shrink the whole map until it fits" behaviour that made
  // a 20×12 map land at ~19px tiles. So the invariant that matters is no longer
  // "everything is on screen at once" but "everything is REACHABLE": zooming out
  // to the overview must show the entire board inside the visible band.
  it('boots at a readable tactical zoom, larger than the screen', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });
      const cam = await bats<{ tileSize: number; origin: { x: number; y: number } }>(
        page,
        'camera.get()',
      );
      const s = await state(page);
      const cols = s.map[0]!.length;
      // Big enough to read a sprite and hit with a thumb.
      expect(cam.tileSize).toBeGreaterThanOrEqual(48);
      // Full-bleed: 12 columns at that zoom overflow a 390px phone, so the board
      // is pannable rather than shrunk to fit.
      expect(cols * cam.tileSize).toBeGreaterThan(W);
    } finally {
      await page.close();
    }
  });

  it('zooming out to the overview brings the whole board into view', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });
      await page.evaluate(() => (window as unknown as BatsWindow).__bats.camera!.fitMap());
      await settleFrames(page, 2);

      const s = await state(page);
      const rows = s.map.length;
      const cols = s.map[0]!.length;
      const corners = [
        { x: 0, y: 0 },
        { x: cols - 1, y: 0 },
        { x: 0, y: rows - 1 },
        { x: cols - 1, y: rows - 1 },
      ];
      for (const c of corners) {
        const p = await bats<{ x: number; y: number }>(page, `tileToScreen({x:${c.x},y:${c.y}})`);
        expect(p.x, `corner ${c.x},${c.y} x in-view`).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(W);
        expect(p.y, `corner ${c.x},${c.y} y in-view`).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(H);
      }
    } finally {
      await page.close();
    }
  });
});
