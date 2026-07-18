// AI turn handoff + turn-steal defence. The human ends turn; the balanced AI
// plays exactly one turn. While it plays, Enter (gated by endTurnAllowed) and
// clicks on the disabled End Turn button are all inert — so control returns to
// P0 at turn 3 with exactly two END_TURNs on record.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'puppeteer';
import { launchBrowser } from '../scripts/lib/browser-harness';
import { awaitIdle, historyOf, newPage, openMap, state } from './helpers';

describe('ai turn', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('runs exactly one AI turn and ignores inputs during it', async () => {
    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel', p1: 'balanced', seed: 42 });

      // Human (P0) ends turn → currentPlayer flips to the AI (P1) synchronously.
      await page.click('[data-action="end-turn"]');

      // Now, mid-AI-turn, spam inputs that must be inert. The AI needs several
      // rAF ticks × pauseMs to finish, so currentPlayer is still 1 here.
      for (let i = 0; i < 3; i++) await page.keyboard.press('Enter');
      for (let i = 0; i < 2; i++) {
        await page.$eval('[data-action="end-turn"]', (b) => (b as HTMLButtonElement).click());
      }

      // Wait for the AI turn to fully complete: control back to P0 at turn 3.
      await page.waitForFunction(
        () => {
          const s = (
            window as unknown as {
              __bats: { getState(): { turn: number; currentPlayer: number } };
            }
          ).__bats.getState();
          return s.currentPlayer === 0 && s.turn === 3;
        },
        { timeout: 30_000, polling: 100 },
      );
      await awaitIdle(page);

      const s = await state(page);
      expect(s.currentPlayer).toBe(0);
      expect(s.turn).toBe(3);
      expect((await historyOf(page, 'END_TURN')).length).toBe(2);
    } finally {
      await page.close();
    }
  });
});
