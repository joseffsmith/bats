// Combat flow on an injected two-infantry adjacency scenario: select attacker,
// open its action menu on its own tile (no move), Attack, pick the target. The
// committed damage must match the pure `previewAttack` prediction, and the
// counterattack must land on the attacker.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'puppeteer';
import { launchBrowser } from '../scripts/lib/browser-harness';
import { createInitialState } from '../src/engine/core/initial-state';
import { previewAttack } from '../src/engine/systems/combat';
import type { GameState } from '../src/engine/core/types';
import {
  awaitIdle,
  clickMenuEntry,
  clickTile,
  newPage,
  openMap,
  setGameState,
  state,
} from './helpers';

/** Two infantry a tile apart on open plain, P0 to act. */
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

describe('combat', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('applies previewAttack damage and a counterattack', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel' });

      const scenario = adjacencyScenario();
      const attackerId = Object.values(scenario.units).find((u) => u.owner === 0)!.id;
      const defenderId = Object.values(scenario.units).find((u) => u.owner === 1)!.id;
      const pred = previewAttack(scenario, attackerId, defenderId);
      expect(pred.dealt).toBeGreaterThan(0);

      await setGameState(page, scenario);

      // Click the attacker's own tile twice: select, then open the action menu
      // in place (no move). onTileClick opens the menu when you re-click the
      // selected unit's tile.
      await clickTile(page, { x: 2, y: 2 });
      await clickTile(page, { x: 2, y: 2 });
      await clickMenuEntry(page, 'Attack');
      await clickTile(page, { x: 3, y: 2 }); // pick the target
      await awaitIdle(page);

      const after = await state(page);
      const defender = after.units[defenderId];
      const attacker = after.units[attackerId];
      expect(defender, 'defender should survive this exchange').toBeTruthy();
      expect(defender!.hp).toBe(100 - pred.dealt);
      // Counter is applied to the attacker (infantry counters at Manhattan 1).
      expect(pred.counterReceived).toBeGreaterThan(0);
      expect(attacker!.hp).toBe(100 - pred.counterReceived);
    } finally {
      await page.close();
    }
  });
});
