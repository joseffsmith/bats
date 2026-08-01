// Visual regression goldens. Opt-in via RUN_VISUAL=1 (these are the only specs
// that assert on pixels, and goldens are machine-sensitive). UPDATE_GOLDENS=1
// writes the reference PNGs instead of comparing.
//
// Determinism: `ambient=off` freezes canvas idle animation (and terrain time),
// an injected stylesheet freezes DOM chrome CSS animation, and we wait for
// fonts.ready — so two captures of the same scene are byte-identical bar
// incidental antialiasing, which the 0.1 pixelmatch threshold + 0.5% budget
// absorb. Mismatches dump actual + diff PNGs to e2e/artifacts/.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Browser } from 'puppeteer';
import { launchBrowser } from '../scripts/lib/browser-harness';
import { awaitIdle, newPage, openMap } from './helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = resolve(HERE, '__goldens__');
const ARTIFACT_DIR = resolve(HERE, 'artifacts');
const MAX_DIFF_RATIO = 0.005; // fail if >0.5% of pixels differ

type VisualCase = {
  name: string;
  map: string;
  width: number;
  height: number;
  /**
   * Shoot the MOBILE shell: touch emulation plus an explicit `?mobile=1`, so
   * the golden covers the HUD strip + full-bleed camera board + command tray
   * rather than the desktop chrome squeezed into a narrow window. The two
   * 390×844 cases are deliberately kept side by side — the desktop one is the
   * regression guard for "a narrow viewport still gets the desktop shell".
   */
  mobile?: boolean;
};

const CASES: VisualCase[] = [
  { name: 'duel-1280x900', map: 'duel', width: 1280, height: 900 },
  { name: 'armada-1280x900', map: 'armada', width: 1280, height: 900 },
  { name: 'duel-390x844', map: 'duel', width: 390, height: 844 },
  { name: 'duel-390x844-mobile', map: 'duel', width: 390, height: 844, mobile: true },
];

describe.skipIf(!process.env.RUN_VISUAL)('visual goldens', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });

  it.each(CASES)('$name matches its golden', async (c) => {
    const page = await newPage(browser);
    try {
      await openMap(page, {
        map: c.map,
        ambient: 'off',
        width: c.width,
        height: c.height,
        deviceScaleFactor: 1,
        // Spread rather than passing `undefined` — exactOptionalPropertyTypes
        // treats "absent" and "present but undefined" as different things, and
        // an absent `mobile` means "let the page decide from (pointer: coarse)".
        ...(c.mobile === true ? { hasTouch: true, isMobile: true, mobile: '1' } : {}),
      });
      await awaitIdle(page);
      // Freeze DOM chrome CSS animations/transitions for a stable capture.
      await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important;}',
      });
      await page.evaluate(() => document.fonts.ready);
      // One more frame so the style + any layout settle before the shot.
      await page.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );

      const shot = Buffer.from(await page.screenshot({ type: 'png' }));
      const goldenPath = resolve(GOLDEN_DIR, `${c.name}.png`);

      if (process.env.UPDATE_GOLDENS) {
        await mkdir(GOLDEN_DIR, { recursive: true });
        await writeFile(goldenPath, shot);
        return;
      }

      if (!existsSync(goldenPath)) {
        throw new Error(`missing golden ${goldenPath} — run UPDATE_GOLDENS=1 RUN_VISUAL=1 first`);
      }
      const actual = PNG.sync.read(shot);
      const golden = PNG.sync.read(await readFile(goldenPath));
      expect(actual.width).toBe(golden.width);
      expect(actual.height).toBe(golden.height);

      const diff = new PNG({ width: golden.width, height: golden.height });
      const mismatched = pixelmatch(
        golden.data,
        actual.data,
        diff.data,
        golden.width,
        golden.height,
        { threshold: 0.1 },
      );
      const total = golden.width * golden.height;
      const ratio = mismatched / total;

      if (ratio > MAX_DIFF_RATIO) {
        await mkdir(ARTIFACT_DIR, { recursive: true });
        await writeFile(resolve(ARTIFACT_DIR, `${c.name}-actual.png`), PNG.sync.write(actual));
        await writeFile(resolve(ARTIFACT_DIR, `${c.name}-diff.png`), PNG.sync.write(diff));
      }
      expect(
        ratio,
        `${c.name}: ${mismatched}/${total} pixels differ (${(ratio * 100).toFixed(3)}%)`,
      ).toBeLessThanOrEqual(MAX_DIFF_RATIO);
    } finally {
      await page.close();
    }
  });
});
