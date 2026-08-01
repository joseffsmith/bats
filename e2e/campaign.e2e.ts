// The teaching campaign, end to end: menu → briefing → coached mission →
// debrief → persisted stars.
//
// The unit suites already cover the pieces in isolation (loader, hint runner,
// tracker, progress store, screens, controller). This spec covers the seams
// only a browser has:
//
//   - `?campaign=menu` short-circuits in main.ts BEFORE `installDebugHook`, so
//     that page has NO `__bats` at all. It is opened with `debug: false` and
//     observed purely through DOM selectors — if a spec here ever waits on the
//     hook, it hangs, which is the tell that the short-circuit moved.
//   - a mission boots the ordinary match with the mission's board, fog and
//     opponent, then mounts the runtime ON TOP of whichever shell resolved:
//     the tray's objective / hint / panel hooks on mobile, the z-97 overlay and
//     floating pills on desktop. Both are asserted, because the runtime cannot
//     tell them apart and neither should silently stop being wired.
//   - the hint script is played, not stubbed: the assertions read the mission's
//     own copy out of src/data/campaign.json, so an edit to the script updates
//     the spec instead of breaking it.
//   - stars land in `localStorage` under `bats.campaign.v1`, which is also the
//     input the menu reads for its locks — so the two are tested against each
//     other rather than against a hand-written blob.
//
// Storage is per-origin and the whole file shares one browser, so every test
// seeds (or clears) `bats.campaign.v1` through `evaluateOnNewDocument` BEFORE
// navigating. Without that, the win test below would unlock mission 2 for the
// menu tests that follow it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { launchBrowser } from '../scripts/lib/browser-harness';
import campaignJson from '../src/data/campaign.json';
import type { Unit } from '../src/engine/core/types';
import {
  awaitIdle,
  awaitStageDebounce,
  clickTile,
  expectNoConsoleErrors,
  historyTypes,
  MOBILE,
  newPage,
  openMap,
  setGameState,
  state,
  trayState,
} from './helpers';

/** The shipped mission 1 — the spec plays along with ITS script, not a copy. */
const M1 = campaignJson.missions[0]!;
const HINTS = M1.hints;
const PROGRESS_KEY = 'bats.campaign.v1';

type ProgressBlob = {
  version: number;
  missions: Record<string, { stars: number; completed: boolean }>;
};

/** Seed (or with `null`, clear) campaign progress before the page loads. */
async function seedProgress(page: Page, record: ProgressBlob | null): Promise<void> {
  const raw = record === null ? null : JSON.stringify(record);
  await page.evaluateOnNewDocument((blob: string | null) => {
    try {
      if (blob === null) window.localStorage.removeItem('bats.campaign.v1');
      else window.localStorage.setItem('bats.campaign.v1', blob);
    } catch {
      // Storage refused (private mode) — the store falls back to memory and the
      // screens say so. Nothing here depends on the write succeeding.
    }
  }, raw);
}

function readProgress(page: Page): Promise<ProgressBlob | null> {
  return page.evaluate((key: string) => {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as ProgressBlob);
  }, PROGRESS_KEY);
}

/** Text of the tray's hint line (the mobile shell's coaching surface). */
function trayHint(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector('[data-tray-hint]')?.textContent ?? '',
  );
}

function waitForHint(page: Page, want: string): Promise<unknown> {
  return page.waitForFunction(
    (text: string) =>
      (document.querySelector('[data-tray-hint]')?.textContent ?? '') === text,
    { timeout: 10_000, polling: 50 },
    want,
  );
}

/** Rows of the mission-select list, as the player sees them. */
function missionRows(page: Page): Promise<
  Array<{ n: string | null; locked: string | null; disabled: boolean; stars: string | null }>
> {
  return page.$$eval('[data-campaign-mission]', (els) =>
    els.map((el) => ({
      n: el.getAttribute('data-campaign-mission'),
      locked: el.getAttribute('data-locked'),
      disabled: (el as HTMLButtonElement).disabled,
      stars:
        el.querySelector('[data-campaign-stars]')?.getAttribute('data-campaign-stars') ??
        null,
    })),
  );
}

describe('teaching campaign', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });

  // ── (a) Briefing → coached mission, on the mobile shell ────────────────────

  it('briefs mission 1 on mobile, then coaches the first scripted step', async () => {
    const page = await newPage(browser);
    try {
      await seedProgress(page, null);
      const captured = await openMap(page, { campaign: '1', ...MOBILE });

      // The briefing arrives through the tray's `presentPanel`, which by
      // tray.ts's own ordering outranks every state-driven body.
      await page.waitForSelector('[data-campaign-screen="intro"]');
      expect(await trayState(page)).toBe('panel');
      const intro = await page.evaluate(() => ({
        mode: document
          .querySelector<HTMLElement>('[data-campaign-screen="intro"]')!
          .getAttribute('data-camp-mode'),
        objective:
          document.querySelector('[data-campaign-objective] .camp-obj-text')?.textContent ??
          '',
        lines: document.querySelectorAll('.camp-line').length,
        scrim: !document.querySelector<HTMLElement>('[data-campaign-scrim]')?.hidden,
      }));
      expect(intro.mode).toBe('mobile');
      expect(intro.objective).toBe(M1.objective);
      expect(intro.lines).toBe(M1.intro.length);
      expect(intro.scrim, 'the board is inert behind a briefing').toBe(true);

      // BEGIN drops the card — which is also what hands control to the player —
      // and arms the objective + the first hint.
      await page.click('[data-campaign-begin]');
      await page.waitForFunction(
        () => document.querySelector('[data-campaign-screen="intro"]') === null,
        { timeout: 10_000, polling: 50 },
      );
      const armed = await page.evaluate(() => ({
        objective:
          document.querySelector<HTMLElement>('[data-tray-objective]')?.textContent ?? '',
        objectiveHidden:
          document.querySelector<HTMLElement>('[data-tray-objective]')?.hidden ?? true,
        scrim: !document.querySelector<HTMLElement>('[data-campaign-scrim]')?.hidden,
      }));
      expect(armed.objective).toBe(M1.objective);
      expect(armed.objectiveHidden).toBe(false);
      expect(armed.scrim, 'the board is live again once the briefing is dismissed').toBe(
        false,
      );
      expect(await trayHint(page)).toBe(HINTS[0]!.text);

      // Play hint 1's step: "tap one of your tanks". The script clears on the
      // input node it asked for and hands the same event to hint 2, so the
      // coaching advances on the very tap it taught.
      await clickTile(page, { x: 2, y: 7 });
      await waitForHint(page, HINTS[1]!.text);

      expectNoConsoleErrors(captured);
    } finally {
      await page.close();
    }
  });

  // ── (b) Win path → debrief + persisted stars ───────────────────────────────

  it('records the win: mission-complete card, stars, and localStorage', async () => {
    const page = await newPage(browser);
    try {
      await seedProgress(page, null);
      await openMap(page, { campaign: '1', ...MOBILE });
      await page.waitForSelector('[data-campaign-screen="intro"]');
      await page.click('[data-campaign-begin]');
      await page.waitForFunction(
        () => document.querySelector('[data-campaign-screen="intro"]') === null,
        { timeout: 10_000, polling: 50 },
      );

      // One wounded defender left, standing next to a P0 tank: killing it routs
      // Kessel. Injected AFTER begin() so the tracker re-baselines on the swap
      // (a raw setState must never look like a massacre — tracker.ts).
      const s = await state(page);
      for (const [id, u] of Object.entries(s.units)) {
        if (u.owner === 1) delete s.units[id];
      }
      const lastId = `last${s.nextUnitId}`;
      const doomed: Unit = {
        id: lastId,
        type: 'infantry',
        owner: 1,
        pos: { x: 2, y: 6 },
        hp: 10,
        hasMoved: false,
        hasActed: false,
        captureProgress: 0,
      };
      s.units[lastId] = doomed;
      s.nextUnitId += 1;
      s.currentPlayer = 0;
      await setGameState(page, s);

      // Select → stage → commit, through the same grammar the mission teaches.
      await clickTile(page, { x: 2, y: 7 });
      await clickTile(page, { x: 2, y: 6 });
      await awaitStageDebounce(page);
      await clickTile(page, { x: 2, y: 6 });
      await awaitIdle(page);

      expect(await historyTypes(page).then((t) => t.at(-1))).toBe('ATTACK');
      expect((await state(page)).winner).toBe(0);

      // The debrief replaces the tray body — mobile never shows chrome's
      // "Vermilion victorious" for a campaign mission.
      await page.waitForSelector('[data-campaign-screen="complete"]');
      const debrief = await page.evaluate(() => ({
        stars: Number(
          document
            .querySelector<HTMLElement>('[data-campaign-stars]')
            ?.getAttribute('data-campaign-stars') ?? '0',
        ),
        maxStars: Number(
          document
            .querySelector<HTMLElement>('[data-campaign-stars]')
            ?.getAttribute('data-campaign-stars-max') ?? '0',
        ),
        criteria: document.querySelectorAll('.camp-criterion').length,
        hasContinue: !!document.querySelector('[data-campaign-continue]'),
      }));
      expect(debrief.stars).toBeGreaterThanOrEqual(1);
      expect(debrief.stars).toBeLessThanOrEqual(debrief.maxStars);
      expect(debrief.maxStars).toBe(3); // win + speed + no losses
      expect(debrief.criteria).toBe(3);
      expect(debrief.hasContinue).toBe(true);

      // …and the same score is on disk under the documented key.
      const stored = await readProgress(page);
      expect(stored, `nothing written to ${PROGRESS_KEY}`).not.toBeNull();
      expect(stored!.version).toBe(1);
      const record = stored!.missions[M1.id];
      expect(record, `no record for ${M1.id}`).toBeTruthy();
      expect(record!.stars).toBeGreaterThanOrEqual(1);
      expect(record!.stars).toBe(debrief.stars);
      expect(record!.completed).toBe(true);
    } finally {
      await page.close();
    }
  });

  // ── (c) The mission list, with and without progress ────────────────────────

  it('lists five missions and locks everything past the first on a fresh profile', async () => {
    const page = await newPage(browser);
    try {
      await seedProgress(page, null);
      // NO debug: `?campaign=menu` returns before installDebugHook, so there is
      // no `__bats` to wait for. DOM selectors are the only observable here.
      const captured = await openMap(page, {
        campaign: 'menu',
        debug: false,
        ...MOBILE,
      });
      await page.waitForSelector('[data-campaign-screen-root="select"]');

      const rows = await missionRows(page);
      expect(rows.length).toBe(campaignJson.missions.length);
      expect(rows.length).toBe(5);
      expect(rows.map((r) => r.n)).toEqual(['1', '2', '3', '4', '5']);
      // Mission 1 is always open; a locked row is inert, not merely dimmed.
      expect(rows[0]!.locked).toBe('false');
      expect(rows[0]!.disabled).toBe(false);
      expect(rows[0]!.stars).toBe('0');
      for (const row of rows.slice(1)) {
        expect(row.locked, `mission ${row.n} should be locked`).toBe('true');
        expect(row.disabled, `mission ${row.n} should be inert`).toBe(true);
        expect(row.stars, 'a locked row shows a padlock, not a score').toBeNull();
      }

      // No game booted behind the list, and no hook was installed.
      const shell = await page.evaluate(() => ({
        hook: '__bats' in window,
        canvas: !!document.querySelector('canvas.board'),
        tray: !!document.querySelector('[data-tray-state]'),
      }));
      expect(shell.hook).toBe(false);
      expect(shell.canvas).toBe(false);
      expect(shell.tray).toBe(false);

      expectNoConsoleErrors(captured);
    } finally {
      await page.close();
    }
  });

  it('unlocks the next mission and renders earned stars from stored progress', async () => {
    const page = await newPage(browser);
    try {
      await seedProgress(page, {
        version: 1,
        missions: { [M1.id]: { stars: 2, completed: true } },
      });
      await openMap(page, { campaign: 'menu', debug: false, ...MOBILE });
      await page.waitForSelector('[data-campaign-screen-root="select"]');

      const rows = await missionRows(page);
      expect(rows[0]!.stars, 'earned stars survive the reload').toBe('2');
      expect(rows[1]!.locked, 'clearing 1 unlocks 2').toBe('false');
      expect(rows[1]!.disabled).toBe(false);
      expect(rows[1]!.stars).toBe('0');
      // …and only the next one: 3 stays behind 2.
      expect(rows[2]!.locked).toBe('true');
      expect(rows[2]!.disabled).toBe(true);
    } finally {
      await page.close();
    }
  });

  // ── (d) Desktop is the same runtime in a different shell ───────────────────

  it('runs the same mission on desktop chrome, in an overlay and pills', async () => {
    const page = await newPage(browser);
    try {
      await seedProgress(page, null);
      // No touch emulation and no `?mobile=` — the desktop path, unchanged.
      const captured = await openMap(page, { campaign: '1' });

      const mounted = await page.evaluate(() => {
        const overlay = document.querySelector<HTMLElement>('[data-campaign-overlay]');
        return {
          overlayShown: !!overlay && !overlay.hidden,
          screen: document
            .querySelector<HTMLElement>('[data-campaign-screen="intro"]')
            ?.getAttribute('data-camp-mode'),
          // Desktop chrome is untouched by the campaign.
          toolshelf: !!document.querySelector('.toolshelf'),
          chrome: !!document.querySelector('.chrome-root'),
          menus: !!document.querySelector('.menus-root'),
          // …and none of the mobile shell leaked in.
          tray: !!document.querySelector('[data-tray-state]'),
          hud: !!document.querySelector('.mhud'),
        };
      });
      expect(mounted.overlayShown, 'the briefing dialog is up').toBe(true);
      expect(mounted.screen).toBe('desktop');
      expect(mounted.toolshelf).toBe(true);
      expect(mounted.chrome).toBe(true);
      expect(mounted.menus).toBe(true);
      expect(mounted.tray).toBe(false);
      expect(mounted.hud).toBe(false);

      await page.click('[data-campaign-begin]');
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>('[data-campaign-overlay]')?.hidden === true,
        { timeout: 10_000, polling: 50 },
      );

      const pills = await page.evaluate(() => {
        const obj = document.querySelector<HTMLElement>('[data-campaign-objective-pill]');
        const hint = document.querySelector<HTMLElement>('[data-campaign-hint]');
        return {
          objective: obj?.textContent ?? '',
          objectiveShown: !!obj && !obj.hidden,
          hint: hint?.textContent ?? '',
          hintShown: !!hint && !hint.hidden,
        };
      });
      expect(pills.objectiveShown).toBe(true);
      expect(pills.objective).toBe(M1.objective);
      expect(pills.hintShown).toBe(true);
      expect(pills.hint).toBe(HINTS[0]!.text);

      // The desktop grammar is unchanged: click 1 selects, and the coaching
      // script advances on the same input node it does on a phone.
      await clickTile(page, { x: 2, y: 7 });
      await page.waitForFunction(
        (text: string) =>
          (document.querySelector('[data-campaign-hint]')?.textContent ?? '') === text,
        { timeout: 10_000, polling: 50 },
        HINTS[1]!.text,
      );

      expectNoConsoleErrors(captured);
    } finally {
      await page.close();
    }
  });
});
