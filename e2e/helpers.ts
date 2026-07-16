// Shared e2e helpers. Every spec drives the live app exclusively through these,
// so the "how" of talking to the page (URL building, the `__bats` hook, canvas
// menu geometry) lives in one place. Phase 2 turns canvas menus into DOM and
// only `clickMenuEntry` changes.
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
};

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
  });
  const captured = wireConsoleCapture(page);
  const url = gameUrl(port, {
    ...(params.map !== undefined ? { map: params.map } : {}),
    ...(params.p0 !== undefined ? { p0: params.p0 } : {}),
    ...(params.p1 !== undefined ? { p1: params.p1 } : {}),
    ...(params.fog !== undefined ? { fog: params.fog } : {}),
    ...(params.ambient !== undefined ? { ambient: params.ambient } : {}),
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
  const p = await page.evaluate(
    (t) => (window as unknown as BatsWindow).__bats.tileToScreen(t),
    tile,
  );
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
 * Click a canvas menu entry by its label. THE single place that knows menus are
 * canvas-drawn: it reads item rects from `__bats.menuRects()` and clicks the
 * matching entry's centre. A successful click always transitions the input
 * machine (and usually appends an action), so we poll for that.
 */
export async function clickMenuEntry(page: Page, label: string): Promise<void> {
  const before = await page.evaluate(() => {
    const b = (window as unknown as BatsWindow).__bats;
    return { kind: b.input.getInputState().kind, hist: b.history.length };
  });
  const target = await page.evaluate((lbl) => {
    const rects = (window as unknown as BatsWindow).__bats.menuRects();
    if (!rects) return null;
    const hit = rects.find((r) => r.label === lbl);
    return hit ? { x: hit.x + hit.w / 2, y: hit.y + hit.h / 2 } : null;
  }, label);
  if (!target) {
    throw new Error(`clickMenuEntry: no open menu entry labelled "${label}"`);
  }
  await page.mouse.click(target.x, target.y);
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
