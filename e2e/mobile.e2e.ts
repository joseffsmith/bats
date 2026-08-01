// Mobile shell on an iPhone-13-ish emulated viewport (390×844, touch).
//
// Phase C replaced the desktop chrome on mobile outright: no toolshelf, no
// mirrored player panels, no tile-anchored popover menus, no floating cancel
// chip. What mounts instead is a 44px HUD strip over a full-bleed camera board
// over a bottom command tray, and the tray is the ONLY place a player issues an
// order. So the specs here are about that shell:
//
//   - the right shell mounted (and the desktop one did not);
//   - the tray projects the input node the mobile grammar is parked on;
//   - the select → stage → commit loop reaches the engine through the tray's
//     CONFIRM button, not just through a third tap;
//   - the camera board is still reachable (Phase A's two invariants, kept).
//
// `mobile=1` is passed explicitly rather than relying on `(pointer: coarse)`:
// the shell under test should not depend on how Chromium reports an emulated
// pointer. Touch emulation stays on because the gesture layer + tap targets are
// the thing being exercised.
//
// Iron rule from helpers.ts still applies: no fixed sleeps — every wait is
// `awaitIdle` or a `waitForFunction` on a real observable.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'puppeteer';
import { launchBrowser } from '../scripts/lib/browser-harness';
import { createInitialState } from '../src/engine/core/initial-state';
import type { GameState } from '../src/engine/core/types';
import type { BatsDebug } from '../src/renderer/debug-hook';
import {
  awaitIdle,
  bats,
  clickTile,
  clickTrayControl,
  endTurn,
  expectNoConsoleErrors,
  historyTypes,
  inputState,
  MOBILE,
  MOBILE_H,
  MOBILE_W,
  newPage,
  openMap,
  setGameState,
  settleFrames,
  state,
  trayState,
  waitForTrayState,
} from './helpers';

type BatsWindow = { __bats: BatsDebug };

const W = MOBILE_W;
const H = MOBILE_H;

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

describe('mobile shell (HUD strip + command tray)', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('mounts the mobile shell and none of the desktop chrome', async () => {
    const page = await newPage(browser);
    try {
      const captured = await openMap(page, { map: 'duel', ...MOBILE });

      const present = await page.evaluate(() => ({
        tray: !!document.querySelector('[data-tray-state]'),
        hud: !!document.querySelector('.mhud'),
        overview: !!document.querySelector('[data-action="overview"]'),
        endTurn: !!document.querySelector('[data-action="end-turn"]'),
        hint: !!document.querySelector('[data-tray-hint]'),
        // Desktop-only surfaces — every one of these must be absent.
        toolshelf: !!document.querySelector('.toolshelf'),
        chrome: !!document.querySelector('.chrome-root'),
        playerPanels: document.querySelectorAll('.player-panel').length,
        menus: !!document.querySelector('.menus-root'),
        cancelChip: !!document.querySelector('[data-action="cancel"]'),
        handoff: !!document.querySelector('.handoff-scrim'),
      }));

      expect(present.tray, 'tray should mount').toBe(true);
      expect(present.hud, 'HUD strip should mount').toBe(true);
      expect(present.overview, 'HUD overview button should mount').toBe(true);
      expect(present.endTurn, 'End Turn keeps its data-action hook').toBe(true);
      expect(present.hint, 'the tray always carries a hint element').toBe(true);
      expect(present.toolshelf, 'desktop toolshelf must NOT mount').toBe(false);
      expect(present.chrome, 'desktop chrome must NOT mount').toBe(false);
      expect(present.playerPanels, 'desktop player panels must NOT mount').toBe(0);
      expect(present.menus, 'desktop DOM menus must NOT mount').toBe(false);
      expect(present.cancelChip, 'the cancel chip is desktop chrome').toBe(false);
      expect(present.handoff, 'fog handoff is desktop-only').toBe(false);

      // The 44px HUD contract, and a tray that fits the viewport.
      const boxes = await page.evaluate(() => {
        const hud = document.querySelector('.mhud')!.getBoundingClientRect();
        const tray = document.querySelector('.tray')!.getBoundingClientRect();
        return {
          hud: { top: hud.top, height: hud.height, width: hud.width },
          tray: { bottom: tray.bottom, left: tray.left, right: tray.right },
          vw: window.innerWidth,
          vh: window.innerHeight,
        };
      });
      expect(boxes.hud.top).toBe(0);
      expect(boxes.hud.height).toBe(44);
      expect(boxes.hud.width).toBe(W);
      expect(boxes.tray.left).toBe(0);
      expect(boxes.tray.right).toBe(W);
      expect(boxes.tray.bottom).toBeLessThanOrEqual(H);

      expectNoConsoleErrors(captured);
    } finally {
      await page.close();
    }
  });

  it('End Turn hands the turn over and the HUD ribbon follows', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });

      const before = await state(page);
      expect(before.currentPlayer).toBe(0);
      const ribbonBefore = await page.$eval(
        '[data-hud-ribbon]',
        (el) => el.textContent ?? '',
      );
      expect(ribbonBefore).toBe('Vermilion to act');

      await endTurn(page);

      const after = await state(page);
      expect(after.currentPlayer).toBe(1);
      expect(after.turn).toBe(before.turn + 1);
      const ribbonAfter = await page.$eval(
        '[data-hud-ribbon]',
        (el) => el.textContent ?? '',
      );
      expect(ribbonAfter).toBe('Cobalt to act');
    } finally {
      await page.close();
    }
  });

  it('tap 1 on an own unit shows its card in the tray', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });

      expect(await trayState(page)).toBe('idle');
      // Duel's P0 infantry stands on (2,2).
      await clickTile(page, { x: 2, y: 2 });
      expect((await inputState(page)).kind).toBe('unit-selected');
      await waitForTrayState(page, 'unit-selected');

      const card = await page.evaluate(() => ({
        name: document.querySelector('.tray-name')?.textContent ?? '',
        chips: Array.from(document.querySelectorAll('.tray-chip')).map(
          (c) => c.textContent ?? '',
        ),
        hint: document.querySelector('[data-tray-hint]')?.textContent ?? '',
      }));
      expect(card.name).toBe('INFANTRY');
      expect(card.chips).toContain('MOVE 3');
      expect(card.chips).toContain('HP 100');
      expect(card.hint.length).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  it('tap 1 on an enemy inspects it instead of selecting anything', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });
      await setGameState(page, adjacencyScenario());

      await clickTile(page, { x: 3, y: 2 });
      expect((await inputState(page)).kind).toBe('enemy-inspect');
      await waitForTrayState(page, 'enemy-inspect');

      const threat = await page.$('[data-tray-threat]');
      expect(threat, 'enemy card offers a threat-range toggle').toBeTruthy();
      // Inspecting is never an action: nothing reached the engine.
      expect(await historyTypes(page)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('select → stage → CONFIRM commits the attack', async () => {
    const page = await newPage(browser);
    try {
      const captured = await openMap(page, { map: 'duel', ...MOBILE });

      const scenario = adjacencyScenario();
      const defenderId = Object.values(scenario.units).find((u) => u.owner === 1)!.id;
      await setGameState(page, scenario);

      // Tap 1: select. Tap 2: stage the attack. Neither touches the engine.
      await clickTile(page, { x: 2, y: 2 });
      await clickTile(page, { x: 3, y: 2 });
      expect((await inputState(page)).kind).toBe('attack-staged');
      await waitForTrayState(page, 'attack-staged');
      expect(await historyTypes(page)).toEqual([]);
      expect((await state(page)).units[defenderId]!.hp).toBe(100);

      // The forecast is real: a positive damage figure is on the card.
      const dealt = await page.$eval(
        '[data-tray-damage]',
        (el) => Number((el as HTMLElement).dataset.trayDamage),
      );
      expect(dealt).toBeGreaterThan(0);

      // Tap CONFIRM: MOVE-then-ATTACK, or ATTACK alone when firing in place.
      await clickTrayControl(page, '[data-tray-confirm]');
      await awaitIdle(page);

      const types = await historyTypes(page);
      const tail = types.slice(-2).join(',');
      expect(
        tail === 'MOVE,ATTACK' || types.at(-1) === 'ATTACK',
        `history should end in an ATTACK, got [${types.join(',')}]`,
      ).toBe(true);
      const after = await state(page);
      expect(after.units[defenderId]!.hp).toBeLessThan(100);
      expect((await inputState(page)).kind).toBe('idle');

      expectNoConsoleErrors(captured);
    } finally {
      await page.close();
    }
  });

  it('CANCEL drops a staged move without touching the engine', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });

      await clickTile(page, { x: 2, y: 2 });
      await clickTile(page, { x: 2, y: 4 });
      expect((await inputState(page)).kind).toBe('move-previewed');
      await waitForTrayState(page, 'move-previewed');

      await clickTrayControl(page, '[data-tray-cancel]');
      expect((await inputState(page)).kind).toBe('idle');
      expect(await historyTypes(page)).toEqual([]);
      await waitForTrayState(page, 'idle');
    } finally {
      await page.close();
    }
  });

  it('build sheet stages a row, then BUILD deploys the unit', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });

      // Fund P0 so the roster is affordable (duel starts both sides at $0).
      const s = await state(page);
      s.players[0].funds = 20000;
      await setGameState(page, s);

      // P0's factory sits at (1,3), one tile below its HQ.
      await clickTile(page, { x: 1, y: 3 });
      expect((await inputState(page)).kind).toBe('build-menu-open');
      await waitForTrayState(page, 'build-menu-open');

      // The build rows keep menus.ts's data hook so e2e/helpers still matches.
      const rows = await page.$$eval('[data-build-entry]', (els) =>
        els.map((e) => e.getAttribute('data-build-entry')),
      );
      expect(rows).toContain('recon');

      // First tap stages — nothing is dispatched yet.
      await page.click('[data-build-entry="recon"]');
      await page.waitForFunction(
        () => {
          const s2 = (window as unknown as BatsWindow).__bats.input.getInputState();
          return s2.kind === 'build-menu-open' && s2.staged === 'recon';
        },
        { timeout: 10_000, polling: 50 },
      );
      expect(await historyTypes(page)).toEqual([]);
      const stagedRow = await page.$eval('[data-build-entry="recon"]', (el) =>
        el.className,
      );
      expect(stagedRow).toContain('staged');

      // BUILD commits.
      await clickTrayControl(page, '[data-tray-confirm]');
      await awaitIdle(page);

      expect(await historyTypes(page)).toEqual(['BUILD']);
      const after = await state(page);
      const built = Object.values(after.units).find(
        (u) => u.owner === 0 && u.pos.x === 1 && u.pos.y === 3,
      );
      expect(built, 'a recon should stand on the factory').toBeTruthy();
      expect(built!.type).toBe('recon');
    } finally {
      await page.close();
    }
  });

  // ── Phase A camera invariants, unchanged ───────────────────────────────────
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

  it('the HUD overview button brings the whole board into view', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });
      // Drive it through the button the player actually taps, not the camera API.
      await page.click('[data-action="overview"]');
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
        const p = await bats<{ x: number; y: number }>(
          page,
          `tileToScreen({x:${c.x},y:${c.y}})`,
        );
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
