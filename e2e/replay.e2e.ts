// Replay modal end-to-end. Node-side we run a deterministic match and turn its
// action log into the JSONL the modal parses. Browser-side we open the modal
// from the toolshelf, paste the log, LOAD it, and step one frame — asserting
// the status line and the displayed state advance.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'puppeteer';
import { launchBrowser } from '../scripts/lib/browser-harness';
import { runMatch } from '../src/cli/run-match';
import { newPage, openMap, state } from './helpers';

describe('replay', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('loads a match log and steps a frame forward', async () => {
    // Deterministic node-side match → JSONL string (no file written).
    const result = await runMatch({
      mapName: 'duel',
      maxTurns: 40,
      seed: 7,
      p0: { name: 'balanced' },
      p1: { name: 'balanced' },
      writeLog: false,
    });
    expect(result.actions.length).toBeGreaterThan(0);
    const lines = [
      JSON.stringify({ type: 'header', map: 'duel', seed: 7, maxTurns: 40, p0: 'balanced', p1: 'balanced' }),
      ...result.actions.map((a) =>
        JSON.stringify({ type: 'action', turn: a.turn, player: a.player, action: a.action }),
      ),
      JSON.stringify({ type: 'summary', turns: result.turns, winner: result.winner }),
    ];
    const jsonl = lines.join('\n');

    const page = await newPage(browser);
    try {
      await openMap(page, { map: 'duel' });

      // Open the replay modal from the toolshelf REPLAY button.
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('.toolshelf .tool')).find((b) =>
          /replay/i.test(b.textContent ?? ''),
        );
        (btn as HTMLElement | undefined)?.click();
      });
      await page.waitForSelector('.replay-modal');

      // Paste the log: set value + dispatch an input event (a real paste path).
      await page.$eval(
        '.replay-textarea',
        (el, text) => {
          const ta = el as HTMLTextAreaElement;
          ta.value = text;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        },
        jsonl,
      );

      // LOAD is the modal's only primary tool button.
      await page.click('.replay-modal .tool.primary');
      await page.waitForFunction(() => {
        const s = document.querySelector('.replay-status');
        return !!s && /frame\s+0\s+\/\s+\d+/.test(s.textContent ?? '');
      });

      const statusLoaded = await page.$eval('.replay-status', (el) => el.textContent ?? '');
      const frameCount = Number(/\/\s+(\d+)/.exec(statusLoaded)?.[1] ?? '0');
      expect(frameCount).toBeGreaterThan(0);
      const turnBefore = (await state(page)).turn;

      // Step forward: Next is the 4th control button (first, prev, play, next).
      await page.$$eval('.replay-controls .tool', (btns) => (btns[3] as HTMLElement).click());
      await page.waitForFunction(() => {
        const s = document.querySelector('.replay-status');
        return !!s && /frame\s+1\s+\//.test(s.textContent ?? '');
      });

      const statusAfter = await page.$eval('.replay-status', (el) => el.textContent ?? '');
      expect(/frame\s+1\s+\//.test(statusAfter)).toBe(true);
      // The displayed state was replaced with frame 1 (turn never regresses).
      const turnAfter = (await state(page)).turn;
      expect(turnAfter).toBeGreaterThanOrEqual(turnBefore);
    } finally {
      await page.close();
    }
  });
});
