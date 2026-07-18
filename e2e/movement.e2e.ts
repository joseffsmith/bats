// Movement flow: select → preview → commit MOVE → action menu → WAIT. Asserts
// against __bats state (unit position, flags, input node, history order), never
// pixels.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'puppeteer';
import { launchBrowser } from '../scripts/lib/browser-harness';
import {
  awaitIdle,
  clickMenuEntry,
  clickTile,
  historyTypes,
  inputState,
  newPage,
  openMap,
  state,
} from './helpers';

describe('movement', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('selects, previews, moves and waits a duel infantry', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel' });

      // P0 infantry starts on (2,2).
      await clickTile(page, { x: 2, y: 2 });
      expect((await inputState(page)).kind).toBe('unit-selected');

      // First click on (3,2) previews the path; second commits the MOVE and
      // opens the action menu at the new tile.
      await clickTile(page, { x: 3, y: 2 });
      expect((await inputState(page)).kind).toBe('move-previewed');
      await clickTile(page, { x: 3, y: 2 });
      await awaitIdle(page); // drain the move animation before touching the menu

      await clickMenuEntry(page, 'Wait');
      await awaitIdle(page);

      const s = await state(page);
      const unit = Object.values(s.units).find(
        (u) => u.owner === 0 && u.pos.x === 3 && u.pos.y === 2,
      );
      expect(unit, 'infantry should now stand on (3,2)').toBeTruthy();
      expect(unit?.hasActed).toBe(true);
      expect((await inputState(page)).kind).toBe('idle');

      // History contains MOVE then WAIT in that order.
      const types = await historyTypes(page);
      const moveIdx = types.indexOf('MOVE');
      const waitIdx = types.indexOf('WAIT');
      expect(moveIdx).toBeGreaterThanOrEqual(0);
      expect(waitIdx).toBeGreaterThan(moveIdx);
    } finally {
      await page.close();
    }
  });
});
