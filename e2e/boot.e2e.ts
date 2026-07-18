// Boot smoke: every built-in map loads, installs the __bats hook, produces a
// non-empty board, and logs no console errors. One test per map so a single
// broken map is pinpointed rather than failing the whole suite.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'puppeteer';
import { launchBrowser } from '../scripts/lib/browser-harness';
import { MAP_NAMES } from '../src/renderer/maps';
import { expectNoConsoleErrors, newPage, openMap, state } from './helpers';

describe('boot', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });

  it.each(MAP_NAMES)('boots %s cleanly with a valid board', async (map) => {
    const page = await newPage(browser);
    try {
      const captured = await openMap(page, { map });
      const present = await page.evaluate(
        () => !!(window as unknown as { __bats?: unknown }).__bats,
      );
      expect(present).toBe(true);

      const s = await state(page);
      expect(s.map.length).toBeGreaterThan(0);
      expect(s.map[0]?.length ?? 0).toBeGreaterThan(0);

      expectNoConsoleErrors(captured);
    } finally {
      await page.close();
    }
  });
});
