// Shared e2e helpers. Every spec drives the live app exclusively through these,
// so the "how" of talking to the page (URL building, the `__bats` hook, menu
// selectors) lives in one place. The menus are DOM (Phase 2.3), so `clickMenuEntry`
// is a plain selector click.
//
// Iron rule: NO fixed sleeps. Every wait is either `awaitIdle` (poll the game's
// own idle predicate) or a `waitForFunction` on a real observable (input-state
// node, applied-action history, turn counter). Fixed `setTimeout`s hide races.

import { expect, inject } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import {
  gameUrl,
  openGame,
  wireConsoleCapture,
  awaitIdle,
} from '../scripts/lib/browser-harness';
import type { BatsDebug } from '../src/renderer/debug-hook';
import type { Action, GameState } from '../src/engine/core/types';

/** In-page shape of the debug hook. Cast target for `page.evaluate` bodies. */
type BatsWindow = { __bats: BatsDebug };

export type Captured = ReturnType<typeof wireConsoleCapture>;

export type OpenParams = {
  map?: string;
  p0?: string;
  p1?: string;
  fog?: string;
  /** Defaults to 42 so runs are reproducible. */
  seed?: number;
  /** `off`/`0` freezes idle animation (visual goldens). */
  ambient?: string;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  /** Touch emulation — set for the mobile spec so `(pointer: coarse)` matches
   *  (drives the two-tap attack + touch menu layouts). Applied BEFORE navigation
   *  so the input controller reads the right pointer type at construction. */
  hasTouch?: boolean;
  isMobile?: boolean;
  /**
   * Force the mobile shell on (`'1'`) or off (`'0'`). Absent → the page decides
   * from `(pointer: coarse)`. The mobile spec sets it explicitly so the shell
   * under test never depends on how Chromium reports an emulated pointer.
   */
  mobile?: string;
  /** Campaign entry point: `'menu'` for the mission list, or a mission number. */
  campaign?: string;
  /**
   * Install the `window.__bats` hook. Defaults to true — every helper below
   * reads through it. Pass `false` for `?campaign=menu`, which short-circuits
   * in main.ts BEFORE `installDebugHook`: that page has no hook at all, so
   * `openGame` must not wait for one and its spec observes DOM selectors only.
   */
  debug?: boolean;
};

/**
 * The mobile-shell page: an iPhone-13-ish 390×844 viewport with touch
 * emulation, plus `?mobile=1`. The parameter is explicit rather than inferred
 * from `(pointer: coarse)` so the shell under test never depends on how
 * Chromium reports an emulated pointer. Spread into `openMap`.
 */
export const MOBILE_W = 390;
export const MOBILE_H = 844;
export const MOBILE = {
  width: MOBILE_W,
  height: MOBILE_H,
  hasTouch: true,
  isMobile: true,
  mobile: '1',
} as const;

/**
 * Navigate a fresh page to the game. Always `debug=1` (the `__bats` hook is how
 * every helper reads state) and `seed=42` unless overridden. Sets a desktop
 * 1280×900 viewport by default so tile geometry is predictable; visual specs
 * pass their own size. Wires console capture BEFORE navigation so first-paint
 * errors are caught.
 */
export async function openMap(page: Page, params: OpenParams = {}): Promise<Captured> {
  const port = inject('e2ePort');
  await page.setViewport({
    width: params.width ?? 1280,
    height: params.height ?? 900,
    deviceScaleFactor: params.deviceScaleFactor ?? 1,
    ...(params.hasTouch !== undefined ? { hasTouch: params.hasTouch } : {}),
    ...(params.isMobile !== undefined ? { isMobile: params.isMobile } : {}),
  });
  const captured = wireConsoleCapture(page);
  const url = gameUrl(port, {
    ...(params.map !== undefined ? { map: params.map } : {}),
    ...(params.p0 !== undefined ? { p0: params.p0 } : {}),
    ...(params.p1 !== undefined ? { p1: params.p1 } : {}),
    ...(params.fog !== undefined ? { fog: params.fog } : {}),
    ...(params.ambient !== undefined ? { ambient: params.ambient } : {}),
    ...(params.mobile !== undefined ? { mobile: params.mobile } : {}),
    ...(params.campaign !== undefined ? { campaign: params.campaign } : {}),
    ...(params.debug !== undefined ? { debug: params.debug } : {}),
    seed: params.seed ?? 42,
  });
  await openGame(page, url);
  return captured;
}

/**
 * Evaluate an expression against `window.__bats` and return it, typed. `fn` is
 * a member expression on the hook, e.g. `'getState()'`, `'idle()'`,
 * `'input.getInputState()'`, `'menuRects()'`.
 */
export function bats<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate((body) => {
    const b = (window as unknown as BatsWindow).__bats;
    return new Function('b', `return b.${body};`)(b) as unknown;
  }, fn) as Promise<T>;
}

export function state(page: Page): Promise<GameState> {
  return bats<GameState>(page, 'getState()');
}

export function inputState(page: Page): Promise<{ kind: string }> {
  return bats<{ kind: string }>(page, 'input.getInputState()');
}

/** All applied actions of a given type, oldest first. */
export function historyOf(page: Page, type: Action['type']): Promise<Action[]> {
  return page.evaluate(
    (t) => (window as unknown as BatsWindow).__bats.history.filter((a) => a.type === t),
    type,
  );
}

/** The applied-action history reduced to its ordered list of action types. */
export function historyTypes(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as BatsWindow).__bats.history.map((a) => a.type),
  );
}

/** Replace the game state (scenario injection), then wait two render frames so
 *  the renderer re-centres the (possibly new) map before any tile click reads
 *  `tileToScreen`. Waiting on rAF syncs to the render loop — not a fixed sleep. */
export async function setGameState(page: Page, next: GameState): Promise<void> {
  await page.evaluate((s) => (window as unknown as BatsWindow).__bats.setState(s), next);
  await settleFrames(page, 2);
}

/** Resolve after `n` animation frames — used to guarantee a draw has happened. */
export function settleFrames(page: Page, n = 2): Promise<void> {
  return page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let i = 0;
        const step = (): void => {
          i += 1;
          if (i >= count) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    n,
  );
}

/**
 * Real mouse click at a tile's centre. Afterwards, wait for the click to have
 * been *processed*: a tile click always moves the input state machine to a new
 * node and/or appends an applied action. We poll for that rather than sleeping.
 * If the click committed an action that animates, callers `awaitIdle` next.
 */
export async function clickTile(page: Page, tile: { x: number; y: number }): Promise<void> {
  const before = await page.evaluate(() => {
    const b = (window as unknown as BatsWindow).__bats;
    return { kind: b.input.getInputState().kind, hist: b.history.length };
  });
  const p = await stableTileToScreen(page, tile);
  await page.mouse.click(p.x, p.y);
  await page.waitForFunction(
    (b0: { kind: string; hist: number }) => {
      const b = (window as unknown as BatsWindow).__bats;
      return b.input.getInputState().kind !== b0.kind || b.history.length !== b0.hist;
    },
    { timeout: 10_000, polling: 50 },
    before,
  );
}

/**
 * Click a menu entry by its label. THE single place that knows how menus are
 * implemented: the menus are DOM now (menus.ts), so an action entry is
 * `[data-menu-entry="<verb>"]` and a build entry is `[data-build-entry="<unitType>"]`.
 * The two label spaces never overlap, so one selector covers both. A successful
 * click always transitions the input machine (and usually appends an action), so
 * we poll for that. Puppeteer's `.click()` auto-scrolls the entry into view — the
 * tall coastal build sheet needs that for its last rows.
 */
export async function clickMenuEntry(page: Page, label: string): Promise<void> {
  const before = await page.evaluate(() => {
    const b = (window as unknown as BatsWindow).__bats;
    return { kind: b.input.getInputState().kind, hist: b.history.length };
  });
  const selector = `[data-menu-entry="${label}"], [data-build-entry="${label}"]`;
  const handle = await page.$(selector);
  if (!handle) {
    throw new Error(`clickMenuEntry: no open menu entry for "${label}"`);
  }
  await handle.click();
  await page.waitForFunction(
    (b0: { kind: string; hist: number }) => {
      const b = (window as unknown as BatsWindow).__bats;
      return b.input.getInputState().kind !== b0.kind || b.history.length !== b0.hist;
    },
    { timeout: 10_000, polling: 50 },
    before,
  );
}

/** Click the DOM End Turn button and wait for the board to settle. */
export async function endTurn(page: Page): Promise<void> {
  await page.click('[data-action="end-turn"]');
  await awaitIdle(page);
}

// ── Mobile command tray ──────────────────────────────────────────────────────
// The tray (renderer/mobile/tray.ts) is a pure projection of the input node, so
// `data-tray-state` is the mobile shell's answer to "what is the machine parked
// on" and the three buttons below are the only way an order reaches the engine
// that isn't a board tap. Same reasoning as `clickMenuEntry`: one place knows
// how the surface is implemented.

/** The tray's current `data-tray-state`, or null when no tray is mounted. */
export function trayState(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document.querySelector<HTMLElement>('[data-tray-state]')?.dataset.trayState ?? null,
  );
}

/** Wait until the tray reports a given state. */
export function waitForTrayState(page: Page, want: string): Promise<unknown> {
  return page.waitForFunction(
    (w: string) =>
      document.querySelector<HTMLElement>('[data-tray-state]')?.dataset.trayState === w,
    { timeout: 10_000, polling: 50 },
    want,
  );
}

/** Click a tray control and wait for the input machine or history to move. */
export async function clickTrayControl(page: Page, selector: string): Promise<void> {
  const before = await page.evaluate(() => {
    const b = (window as unknown as BatsWindow).__bats;
    return { kind: b.input.getInputState().kind, hist: b.history.length };
  });
  await page.click(selector);
  await page.waitForFunction(
    (b0: { kind: string; hist: number }) => {
      const b = (window as unknown as BatsWindow).__bats;
      return b.input.getInputState().kind !== b0.kind || b.history.length !== b0.hist;
    },
    { timeout: 10_000, polling: 50 },
    before,
  );
}

/**
 * Wait out the mobile grammar's stage→commit debounce (`STAGE_DEBOUNCE_MS` in
 * input.ts: a re-tap inside 150ms is a double-tap, not a decision, and is
 * dropped). NOT a sleep — it polls the staged node's own `stagedAt` stamp
 * against the same clock input.ts reads (`Date.now`), so it resolves the
 * instant the tap would be honoured and never resolves at all if nothing is
 * staged, which is exactly the failure a spec would want to see.
 */
export function awaitStageDebounce(page: Page, marginMs = 25): Promise<unknown> {
  return page.waitForFunction(
    (margin: number) => {
      const s = (window as unknown as BatsWindow).__bats.input.getInputState() as {
        stagedAt?: number;
      };
      return typeof s.stagedAt === 'number' && Date.now() - s.stagedAt >= 150 + margin;
    },
    { timeout: 10_000, polling: 20 },
    marginMs,
  );
}

/**
 * Poll until the live input node satisfies `expr` — a JS expression over `s`,
 * the node (e.g. `"s.kind === 'move-previewed' && s.destination.x === 4"`).
 * `clickTile` can only wait for the node's KIND to change, which is blind to
 * the mobile grammar's re-stage (move-previewed → move-previewed with a new
 * destination); this sees it.
 */
export function waitForInput(page: Page, expr: string): Promise<unknown> {
  return page.waitForFunction(
    (body: string) => {
      const s = (window as unknown as BatsWindow).__bats.input.getInputState();
      return new Function('s', `return ${body};`)(s) === true;
    },
    { timeout: 10_000, polling: 50 },
    expr,
  );
}

/**
 * Tap a tile WITHOUT waiting for the machine to move. `clickTile` is the right
 * tool almost everywhere; this one exists for the mobile grammar's re-stage and
 * mis-tap cases, where the observable that changes is inside the node rather
 * than its kind. Callers follow it with `waitForInput`.
 */
export async function tapTile(page: Page, tile: { x: number; y: number }): Promise<void> {
  const p = await stableTileToScreen(page, tile);
  await page.mouse.click(p.x, p.y);
}

/**
 * A tile's screen point, read only once it has stopped moving. On the mobile
 * shell the camera EASES (boot centring, overview toggles, AI auto-follow run
 * ~250ms tweens), so a coordinate read mid-flight is stale by the time the
 * click lands and can hit the neighbouring tile. Poll until two consecutive
 * animation frames agree (sub-half-pixel) — during a tween consecutive frames
 * always differ, so agreement means the camera has settled. Desktop pages have
 * no camera and exit on the first pair of frames. Not a fixed sleep: this waits
 * on the observable that actually gates a correct click.
 */
async function stableTileToScreen(
  page: Page,
  tile: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  return page.evaluate(async (t) => {
    const b = (window as unknown as BatsWindow).__bats;
    const frame = (): Promise<void> =>
      new Promise((r) => requestAnimationFrame(() => r()));
    let prev = b.tileToScreen(t);
    // 120 frames ≈ 2s at 60Hz — far beyond any camera tween; bail with the
    // latest read rather than hang if something animates forever.
    for (let i = 0; i < 120; i += 1) {
      await frame();
      const cur = b.tileToScreen(t);
      if (Math.abs(cur.x - prev.x) < 0.5 && Math.abs(cur.y - prev.y) < 0.5) return cur;
      prev = cur;
    }
    return prev;
  }, tile);
}

// Vite's HMR client + a couple of well-known dev-only lines are benign; every
// other console error / pageerror fails the assertion.
const BENIGN_CONSOLE = [
  /\[vite\]/i,
  /vite.*connect/i,
  /Download the .* DevTools/i,
];

/** Assert the page produced no non-benign console errors during the run. */
export function expectNoConsoleErrors(captured: Captured): void {
  const real = captured.errors.filter((e) => !BENIGN_CONSOLE.some((re) => re.test(e)));
  expect(real, `unexpected console errors:\n${real.join('\n')}`).toEqual([]);
}

export { awaitIdle } from '../scripts/lib/browser-harness';

/** Convenience: open a fresh page on the shared browser. */
export async function newPage(browser: Browser): Promise<Page> {
  return browser.newPage();
}
