// Build, capture, and win flows.
//
//  (a) Armada coastal factory offers all 14 buildable types; the LAST entry
//      must be clickable (bug-3 regression: the overflowing menu used to render
//      its final rows under the DOM chrome, which swallowed the click).
//  (b) A P0 infantry parked mid-capture on an enemy city flips it on CAPTURE.
//  (c) Capturing the enemy HQ ends the match: the DOM winner overlay appears
//      and further board clicks are inert.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'puppeteer';
import { launchBrowser } from '../scripts/lib/browser-harness';
import type { Unit } from '../src/engine/core/types';
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

type MenuRect = { kind: string; label: string; x: number; y: number; w: number; h: number };

function infantryOn(id: string, pos: { x: number; y: number }, captureProgress: number): Unit {
  return {
    id,
    type: 'infantry',
    owner: 0,
    pos: { ...pos },
    hp: 100,
    hasMoved: false,
    hasActed: false,
    captureProgress,
  };
}

describe('build / capture / win', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('builds the last (14th) coastal-factory entry', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'armada' });

      // Fund P0 so every entry is affordable, keeping the same armada board.
      const s = await state(page);
      s.players[0].funds = 99999;
      await setGameState(page, s);

      // P0 coastal factory is at (3,9). Clicking it opens the build menu.
      await clickTile(page, { x: 3, y: 9 });
      expect((await inputState(page)).kind).toBe('build-menu-open');

      const rects = await bats<MenuRect[]>(page, 'menuRects()');
      expect(rects.length).toBe(14);
      const lastLabel = rects[rects.length - 1]!.label;

      await clickMenuEntry(page, lastLabel);
      await awaitIdle(page);

      const after = await state(page);
      const built = Object.values(after.units).find(
        (u) => u.owner === 0 && u.pos.x === 3 && u.pos.y === 9,
      );
      expect(built, `a "${lastLabel}" should have been built on (3,9)`).toBeTruthy();
    } finally {
      await page.close();
    }
  });

  it('captures an enemy city and flips its ownership', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel' });

      const s = await state(page);
      // Duel city at (3,1): make it enemy-held, park a P0 infantry one tick from
      // flipping it (progress 10 + floor(100/10)=10 → 20 → flip).
      s.map[1]![3] = { terrain: 'city', owner: 1 };
      for (const id of Object.keys(s.units)) {
        const u = s.units[id]!;
        if (u.pos.x === 3 && u.pos.y === 1) delete s.units[id];
      }
      const id = `cap${s.nextUnitId}`;
      s.units[id] = infantryOn(id, { x: 3, y: 1 }, 10);
      s.nextUnitId += 1;
      s.currentPlayer = 0;
      await setGameState(page, s);

      await clickTile(page, { x: 3, y: 1 }); // select
      await clickTile(page, { x: 3, y: 1 }); // open action menu
      await clickMenuEntry(page, 'Capture');
      await awaitIdle(page);

      const after = await state(page);
      expect(after.map[1]![3]!.owner).toBe(0);
      expect(after.winner).toBeNull();
    } finally {
      await page.close();
    }
  });

  it('wins by capturing the enemy HQ and locks the board', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel' });

      const s = await state(page);
      const hq = s.players[1].hq; // (10,2)
      for (const id of Object.keys(s.units)) {
        const u = s.units[id]!;
        if (u.pos.x === hq.x && u.pos.y === hq.y) delete s.units[id];
      }
      const id = `win${s.nextUnitId}`;
      s.units[id] = infantryOn(id, hq, 10);
      s.nextUnitId += 1;
      s.currentPlayer = 0;
      await setGameState(page, s);

      await clickTile(page, { x: hq.x, y: hq.y }); // select
      await clickTile(page, { x: hq.x, y: hq.y }); // open action menu
      await clickMenuEntry(page, 'Capture');
      await awaitIdle(page);

      const after = await state(page);
      expect(after.winner).toBe(0);

      // The DOM winner overlay (chrome.ts) is visible.
      const overlayShown = await page.evaluate(() => {
        const el = document.querySelector('.winner-overlay');
        return !!el && !(el as HTMLElement).hidden;
      });
      expect(overlayShown).toBe(true);

      // Further board clicks are inert once the match is decided.
      const histBefore = (await bats<unknown[]>(page, 'history')).length;
      const coord = await bats<{ x: number; y: number }>(page, 'tileToScreen({x:5,y:4})');
      await page.mouse.click(coord.x, coord.y);
      await settleFrames(page, 2);
      const histAfter = (await bats<unknown[]>(page, 'history')).length;
      expect(histAfter).toBe(histBefore);
      expect((await state(page)).winner).toBe(0);
    } finally {
      await page.close();
    }
  });
});
