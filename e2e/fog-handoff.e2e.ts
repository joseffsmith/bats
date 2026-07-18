// Hot-seat fog handoff interstitial. With `?fog=on` and two human controllers,
// ending a turn drops an opaque pass-the-device scrim (so the outgoing player
// never sees the incoming player's vision), and Enter can't end a turn while it's
// up. An AI-involved fog game never shows the scrim.
//
// We DOM-assert the scrim + button (not pixels) and read the ply counter through
// the __bats hook. No fixed sleeps: waits are on the scrim's visibility, the turn
// counter, or rAF frames (settleFrames).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'puppeteer';
import { launchBrowser } from '../scripts/lib/browser-harness';
import {
  awaitIdle,
  expectNoConsoleErrors,
  newPage,
  openMap,
  settleFrames,
  state,
} from './helpers';

describe('fog handoff', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('shows the scrim on END_TURN (both human) and blocks Enter until dismissed', async () => {
    const page = await newPage(browser);
    try {
      const captured = await openMap(page, { fog: 'on' });
      // Both controllers human by default; a fresh board is ply 1.
      expect((await state(page)).turn).toBe(1);

      // End P0's turn → currentPlayer flips to P1 and the scrim drops.
      await page.click('[data-action="end-turn"]');
      await page.waitForSelector('.handoff-scrim:not([hidden])', {
        visible: true,
        timeout: 10_000,
      });

      // The Begin-turn button is present under the scrim.
      expect(await page.$('[data-action="begin-turn"]')).not.toBeNull();

      // The END_TURN did apply — only the *view* is held — so the ply is now 2.
      const turnBefore = (await state(page)).turn;
      expect(turnBefore).toBe(2);

      // Enter while the scrim is up must NOT end the turn (endTurnAllowed folds
      // in !handoffActive()). Press, settle a few frames, assert ply unchanged.
      await page.keyboard.press('Enter');
      await settleFrames(page, 3);
      expect((await state(page)).turn).toBe(turnBefore);

      // Begin turn dismisses the scrim.
      await page.click('[data-action="begin-turn"]');
      await page.waitForFunction(
        () => {
          const el = document.querySelector('.handoff-scrim');
          return !el || (el as HTMLElement).hidden;
        },
        { timeout: 10_000, polling: 50 },
      );
      expect(await page.$('.handoff-scrim:not([hidden])')).toBeNull();

      expectNoConsoleErrors(captured);
    } finally {
      await page.close();
    }
  });

  it('never shows the scrim in an AI-involved fog game', async () => {
    const page = await newPage(browser);
    try {
      const captured = await openMap(page, { fog: 'on', p1: 'balanced', seed: 42 });

      // End P0's turn → currentPlayer flips to the AI (P1) synchronously.
      await page.click('[data-action="end-turn"]');
      await page.waitForFunction(
        () =>
          (window as unknown as { __bats: { getState(): { currentPlayer: number } } }).__bats
            .getState().currentPlayer === 1,
        { timeout: 10_000, polling: 50 },
      );
      // bothHuman() is false → no scrim on the handoff into the AI turn.
      await settleFrames(page, 3);
      expect(await page.$('.handoff-scrim:not([hidden])')).toBeNull();

      // Let the AI finish and hand control back to P0 — still no scrim (the game
      // is AI-involved for the whole match).
      await awaitIdle(page);
      expect(await page.$('.handoff-scrim:not([hidden])')).toBeNull();

      expectNoConsoleErrors(captured);
    } finally {
      await page.close();
    }
  });
});
