// The mobile tap grammar, end to end: select → stage → commit.
//
// tests/input-mobile-grammar.test.ts already pins the state machine in node
// (stub renderer, injected clock). This spec asks the other question — does the
// grammar survive the round trip through a real browser: a real tile hit-test
// through the camera transform, a real 150ms wall clock, the tray re-rendering
// between every tap, and the engine + animation queue underneath.
//
// The contract each case defends is the same one sentence:
//
//     nothing reaches the engine until the player says so twice.
//
// Tap 1 selects or inspects, tap 2 stages a verb and paints the forecast, and
// only tap 3 (on the SAME target, after the debounce) or an explicit tray
// button commits. So every case here asserts the negative — `historyTypes()` is
// still empty, the defender is still at 100 — before it asserts the commit.
//
// Deliberately complementary to e2e/mobile.e2e.ts rather than overlapping it:
// that spec drives the tray's CONFIRM button on an attack and on a build; this
// one drives the third TAP (the path a player actually uses on the board), the
// mis-tap re-stage, and CONFIRM on a staged move.
//
// Iron rule from helpers.ts: no fixed sleeps. The debounce is waited out by
// polling the staged node's own `stagedAt` stamp (`awaitStageDebounce`), never
// by sleeping 150ms and hoping.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'puppeteer';
import { launchBrowser } from '../scripts/lib/browser-harness';
import { createInitialState } from '../src/engine/core/initial-state';
import type { Coord, GameState, Unit } from '../src/engine/core/types';
import {
  awaitIdle,
  awaitStageDebounce,
  bats,
  clickTile,
  clickTrayControl,
  expectNoConsoleErrors,
  historyTypes,
  inputState,
  MOBILE,
  newPage,
  openMap,
  setGameState,
  state,
  tapTile,
  trayState,
  waitForInput,
  waitForTrayState,
} from './helpers';

/** Where the P0 tank stands in every injected scenario below. */
const TANK: Coord = { x: 2, y: 2 };

/**
 * A 7×7 plain board with one P0 tank at (2,2) and one P1 soldier wherever the
 * case puts it. Plain everywhere means the firing-tile tiebreak (defense stars,
 * then path cost, then map order — mobile/verbs.ts) resolves on COST alone, so
 * the staged firing position is predictable by hand and the spec can assert it.
 */
function tankVs(enemy: Coord): GameState {
  return createInitialState({
    width: 7,
    height: 7,
    hqs: [
      { owner: 0, pos: { x: 0, y: 6 } },
      { owner: 1, pos: { x: 6, y: 0 } },
    ],
    units: [
      { type: 'tank', owner: 0, pos: TANK },
      { type: 'infantry', owner: 1, pos: enemy },
    ],
  });
}

function enemyOf(s: GameState): Unit {
  return Object.values(s.units).find((u) => u.owner === 1)!;
}

describe('mobile grammar (select → stage → commit)', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });

  // ── (a) Move ───────────────────────────────────────────────────────────────

  it('stages a move on tap 2 and only commits it on tap 3', async () => {
    const page = await newPage(browser);
    try {
      const captured = await openMap(page, { map: 'duel', ...MOBILE });
      await setGameState(page, tankVs({ x: 6, y: 6 }));

      // Tap 1: select. The board lights up; nothing is dispatched.
      await clickTile(page, TANK);
      expect((await inputState(page)).kind).toBe('unit-selected');
      await waitForTrayState(page, 'unit-selected');
      expect(await historyTypes(page)).toEqual([]);

      // Tap 2: stage. Still nothing dispatched, and the unit has NOT moved —
      // the board must not change under the player's finger.
      const dest = { x: 2, y: 4 };
      await clickTile(page, dest);
      expect((await inputState(page)).kind).toBe('move-previewed');
      await waitForTrayState(page, 'move-previewed');
      expect(await historyTypes(page)).toEqual([]);
      const staged = await state(page);
      expect(Object.values(staged.units).find((u) => u.owner === 0)!.pos).toEqual(TANK);

      // Tap 3 on the same tile, once the double-tap guard has expired.
      await awaitStageDebounce(page);
      await clickTile(page, dest);
      await awaitIdle(page);

      // A bare move fuses a WAIT: MOVE alone marks hasMoved but not hasActed,
      // and the mobile grammar treats "I tapped this tile" as the unit's turn.
      expect(await historyTypes(page)).toEqual(['MOVE', 'WAIT']);
      const after = await state(page);
      const tank = Object.values(after.units).find((u) => u.owner === 0)!;
      expect(tank.pos).toEqual(dest);
      expect(tank.hasActed).toBe(true);
      expect((await inputState(page)).kind).toBe('idle');
      await waitForTrayState(page, 'idle');

      expectNoConsoleErrors(captured);
    } finally {
      await page.close();
    }
  });

  // ── (b) Attack ─────────────────────────────────────────────────────────────

  it('fires in place when the target is already adjacent', async () => {
    const page = await newPage(browser);
    try {
      const captured = await openMap(page, { map: 'duel', ...MOBILE });
      const scenario = tankVs({ x: 3, y: 2 });
      const defenderId = enemyOf(scenario).id;
      await setGameState(page, scenario);

      await clickTile(page, TANK);
      await clickTile(page, { x: 3, y: 2 });

      // The tank already stands in range, and its own tile costs 0 to reach —
      // so the staged firing position is where it is, with an empty path.
      const node = await bats<{ kind: string; firingPos: Coord; path: Coord[] }>(
        page,
        'input.getInputState()',
      );
      expect(node.kind).toBe('attack-staged');
      expect(node.firingPos).toEqual(TANK);
      expect(node.path).toEqual([]);
      await waitForTrayState(page, 'attack-staged');

      // Staging is not attacking: the engine has seen nothing.
      expect(await historyTypes(page)).toEqual([]);
      expect((await state(page)).units[defenderId]!.hp).toBe(100);

      await awaitStageDebounce(page);
      await clickTile(page, { x: 3, y: 2 });
      await awaitIdle(page);

      // No MOVE leg — the shot is the whole commit.
      expect(await historyTypes(page)).toEqual(['ATTACK']);
      const after = await state(page);
      expect(after.units[defenderId]?.hp ?? 0).toBeLessThan(100);
      expect((await inputState(page)).kind).toBe('idle');

      expectNoConsoleErrors(captured);
    } finally {
      await page.close();
    }
  });

  it('stages a deterministic firing tile and commits MOVE then ATTACK', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });
      const scenario = tankVs({ x: 5, y: 2 });
      const defenderId = enemyOf(scenario).id;
      await setGameState(page, scenario);

      await clickTile(page, TANK);
      await clickTile(page, { x: 5, y: 2 });

      // Four tiles are adjacent to (5,2); all are plain, so the tiebreak falls
      // through to path cost and (4,2) — two steps away — wins outright.
      const node = await bats<{ kind: string; firingPos: Coord; path: Coord[] }>(
        page,
        'input.getInputState()',
      );
      expect(node.kind).toBe('attack-staged');
      expect(node.firingPos).toEqual({ x: 4, y: 2 });
      expect(node.path).toEqual([
        { x: 3, y: 2 },
        { x: 4, y: 2 },
      ]);
      expect(await historyTypes(page)).toEqual([]);
      expect((await state(page)).units[defenderId]!.hp).toBe(100);

      await awaitStageDebounce(page);
      await clickTile(page, { x: 5, y: 2 });
      await awaitIdle(page);

      // The commit is a SEQUENCE of existing engine actions, in one handler.
      expect(await historyTypes(page)).toEqual(['MOVE', 'ATTACK']);
      const after = await state(page);
      expect(Object.values(after.units).find((u) => u.owner === 0)!.pos).toEqual({
        x: 4,
        y: 2,
      });
      expect(after.units[defenderId]?.hp ?? 0).toBeLessThan(100);
    } finally {
      await page.close();
    }
  });

  // ── (c) Mis-tap safety ─────────────────────────────────────────────────────

  it('re-stages on a mis-tap instead of committing anything', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });
      await setGameState(page, tankVs({ x: 5, y: 2 }));

      await clickTile(page, TANK);
      await clickTile(page, { x: 2, y: 4 });
      await waitForInput(page, "s.kind === 'move-previewed' && s.destination.y === 4");

      // A tap on a DIFFERENT legal tile re-stages. The node's kind doesn't
      // change, so this waits on the destination — the thing that moved.
      await tapTile(page, { x: 4, y: 4 });
      await waitForInput(
        page,
        "s.kind === 'move-previewed' && s.destination.x === 4 && s.destination.y === 4",
      );
      expect(await historyTypes(page)).toEqual([]);

      // Including a mis-tap onto a different VERB: the staged move becomes a
      // staged attack, and still nothing has been dispatched.
      await tapTile(page, { x: 5, y: 2 });
      await waitForInput(page, "s.kind === 'attack-staged'");
      expect(await historyTypes(page)).toEqual([]);

      // Wait out the debounce and cancel: the whole sequence cost the player
      // nothing but taps.
      await awaitStageDebounce(page);
      await clickTrayControl(page, '[data-tray-cancel]');
      expect((await inputState(page)).kind).toBe('idle');
      expect(await historyTypes(page)).toEqual([]);
      const after = await state(page);
      expect(Object.values(after.units).find((u) => u.owner === 0)!.pos).toEqual(TANK);
      expect(after.units[enemyOf(after).id]!.hp).toBe(100);
    } finally {
      await page.close();
    }
  });

  // ── (d) The tray's CONFIRM button ──────────────────────────────────────────

  it('CONFIRM commits a staged move without a third tap', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });
      await setGameState(page, tankVs({ x: 6, y: 6 }));

      await clickTile(page, TANK);
      await clickTile(page, { x: 2, y: 4 });
      await waitForTrayState(page, 'move-previewed');
      expect(await historyTypes(page)).toEqual([]);

      // An explicit button press is never an accidental double-tap, so
      // `confirmStaged` deliberately skips the debounce — no wait here.
      await clickTrayControl(page, '[data-tray-confirm]');
      await awaitIdle(page);

      expect(await historyTypes(page)).toEqual(['MOVE', 'WAIT']);
      expect(Object.values((await state(page)).units).find((u) => u.owner === 0)!.pos).toEqual(
        { x: 2, y: 4 },
      );
      expect(await trayState(page)).toBe('idle');
    } finally {
      await page.close();
    }
  });

  // ── (e) Build ──────────────────────────────────────────────────────────────

  it('stages a build row and deploys it on the second tap of the same row', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', ...MOBILE });

      // Duel starts both sides at $0; fund P0 so the roster is affordable.
      const s = await state(page);
      s.players[0].funds = 20000;
      await setGameState(page, s);

      // P0's factory sits at (1,3), one tile below its HQ.
      await clickTile(page, { x: 1, y: 3 });
      expect((await inputState(page)).kind).toBe('build-menu-open');
      await waitForTrayState(page, 'build-menu-open');

      // Tap 1 on the row stages it — the sheet gets the same stage → confirm
      // rhythm as the board, so it needs no grammar of its own.
      await page.click('[data-build-entry="infantry"]');
      await waitForInput(
        page,
        "s.kind === 'build-menu-open' && s.staged === 'infantry'",
      );
      expect(await historyTypes(page)).toEqual([]);
      const midway = await state(page);
      expect(midway.players[0].funds, 'staging must not spend anything').toBe(20000);

      // Tap 2 on the SAME row deploys it (mobile.e2e.ts covers the BUILD button).
      await page.click('[data-build-entry="infantry"]');
      await awaitIdle(page);

      expect(await historyTypes(page)).toEqual(['BUILD']);
      const after = await state(page);
      const built = Object.values(after.units).find(
        (u) => u.owner === 0 && u.pos.x === 1 && u.pos.y === 3,
      );
      expect(built, 'an infantry should stand on the factory').toBeTruthy();
      expect(built!.type).toBe('infantry');
      expect(after.players[0].funds).toBeLessThan(20000);
    } finally {
      await page.close();
    }
  });

  // ── (f) Enemy inspection ───────────────────────────────────────────────────

  it('inspects an enemy and toggles its threat range without acting', async () => {
    const page = await newPage(browser);
    try {
      const captured = await openMap(page, { map: 'duel', ...MOBILE });
      await setGameState(page, tankVs({ x: 5, y: 2 }));

      // Tap 1 on an enemy is inspection, never selection: there is nothing the
      // player can order it to do. The threat overlay is ON by default — the
      // tap is asking "what can this thing hit".
      await clickTile(page, { x: 5, y: 2 });
      expect((await inputState(page)).kind).toBe('enemy-inspect');
      await waitForTrayState(page, 'enemy-inspect');
      expect(
        await bats<boolean>(page, 'input.getInputState().showThreat'),
      ).toBe(true);
      const label = await page.$eval(
        '[data-tray-threat]',
        (el) => el.textContent ?? '',
      );
      expect(label).toContain('HIDE');

      // The threat toggle changes the input node in place — same kind, new
      // flag — so waiting on the flag is the only honest observable.
      await page.click('[data-tray-threat]');
      await waitForInput(page, "s.kind === 'enemy-inspect' && s.showThreat === false");
      const shown = await page.$eval(
        '[data-tray-threat]',
        (el) => el.textContent ?? '',
      );
      expect(shown).toContain('SHOW');

      await page.click('[data-tray-threat]');
      await waitForInput(page, "s.kind === 'enemy-inspect' && s.showThreat === true");

      // Inspecting is never an action.
      expect(await historyTypes(page)).toEqual([]);
      expectNoConsoleErrors(captured);
    } finally {
      await page.close();
    }
  });
});
