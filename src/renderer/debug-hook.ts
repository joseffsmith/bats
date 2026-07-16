// `window.__bats` debug/automation hook.
//
// Installed only when the page is loaded with `?debug=1` (see main.ts). It
// exposes a tiny, stable surface that headless drivers (puppeteer, the shoot /
// e2e harnesses) and manual console pokes can use to read game state, inject
// scenarios, drive synthetic input, and — crucially — *await settlement*: an
// automated driver clicks "End Turn" and then polls `idle()` until both the
// animation queue and the AI driver have gone quiet, instead of sleeping a
// fixed number of milliseconds and hoping.
//
// This is a READ/CONTROL boundary, not a new state store. Everything here
// delegates to the already-wired renderer modules; the hook owns nothing except
// the rolling `history` buffer.

import type { Action, Coord, GameState } from '../engine/core/types';
import type { Emitter } from './emitter';
import type { CanvasRenderer } from './canvas';
import type { InputController, InputState } from './input';
import type { AnimationQueue } from './animations';
import type { AIDriver } from './ai-driver';

/** Rolling cap for the applied-action history buffer. */
const HISTORY_CAP = 500;

/**
 * A clickable menu item rect in CSS pixels, with the entry's data-attr label.
 * The menus are DOM now (menus.ts), so this is a thin query over the mounted
 * `[data-menu-entry]` / `[data-build-entry]` buttons — the e2e helpers click the
 * selectors directly and only the `drive` REPL's `menu` command still reads this
 * shape. `label` is the data-attr value: an action verb ('Attack', 'Wait', …)
 * for action entries, or the unit type ('infantry', …) for build entries.
 */
export type MenuRect = {
  kind: 'action' | 'build';
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type BatsDebug = {
  /** Bumped when the shape changes so drivers can assert compatibility. */
  version: 1;
  getState(): GameState;
  /** emitter.dispatch — routes through the reducer. Test setup only. */
  dispatch(a: Action): GameState;
  /** emitter.setState — replaces state without the reducer (scenario injection). */
  setState(s: GameState): void;
  input: {
    click(x: number, y: number, button?: number): void;
    hover(x: number, y: number): void;
    cancel(): void;
    /** Current input state-machine node (idle / unit-selected / …). */
    getInputState(): InputState;
  };
  /** Tile CENTRE in CSS pixels — what a driver should click. */
  tileToScreen(c: Coord): { x: number; y: number };
  pixelToTile(x: number, y: number): Coord | null;
  /**
   * Item rects for the currently-open DOM menu (action or build), or null when
   * no menu is open. Read from the mounted menu buttons' bounding rects, so a
   * click at an item's centre lands exactly where the human would tap.
   */
  menuRects(): MenuRect[] | null;
  animBusy(): boolean;
  aiBusy(): boolean;
  /** True iff nothing is animating and no AI plan is being played out. */
  idle(): boolean;
  /** Last 500 APPLIED actions, oldest first. */
  history: Action[];
};

declare global {
  interface Window {
    __bats?: BatsDebug;
  }
}

/** Map a mounted menu button to the stable MenuRect shape via its bounding box. */
function rectFor(
  el: HTMLElement,
  kind: MenuRect['kind'],
  label: string,
): MenuRect {
  const r = el.getBoundingClientRect();
  return { kind, label, x: r.x, y: r.y, w: r.width, h: r.height };
}

export type DebugHookDeps = {
  emitter: Emitter;
  renderer: CanvasRenderer;
  input: InputController;
  animQueue: AnimationQueue;
  aiDriver: AIDriver;
};

/**
 * Wire up `window.__bats` against the live renderer modules. Returns the object
 * for tests (which install against a real emitter + stub renderer without a
 * `window`). Idempotent-ish: a second call overwrites the previous hook.
 */
export function installDebugHook(deps: DebugHookDeps): BatsDebug {
  const { emitter, renderer, input, animQueue, aiDriver } = deps;

  const history: Action[] = [];
  // The emitter emits `stateChanged` after every dispatch, but sets
  // `action: null` for (a) reducer no-ops / rejected illegal dispatches —
  // `dispatch()` passes `changed ? action : null` — and (b) overlay-only
  // refreshes emitted by `setState` and the input controller's `emit(...)`.
  // So filtering on `action !== null` yields exactly the actions the reducer
  // actually APPLIED, which is what we want in the history buffer.
  emitter.on((ev) => {
    if (ev.type !== 'stateChanged' || ev.action === null) return;
    history.push(ev.action);
    if (history.length > HISTORY_CAP) history.shift();
  });

  function animBusy(): boolean {
    return animQueue.busy();
  }
  function aiBusy(): boolean {
    return aiDriver.busy();
  }

  const hook: BatsDebug = {
    version: 1,
    getState: () => emitter.getState(),
    dispatch: (a) => emitter.dispatch(a),
    setState: (s) => emitter.setState(s),
    input: {
      click: (x, y, button) => input.click(x, y, button),
      hover: (x, y) => input.hover(x, y),
      cancel: () => input.cancel(),
      getInputState: () => input.getState(),
    },
    tileToScreen: (c) => {
      const p = renderer.tileToPixel(c);
      const half = renderer.getViewport().tileSize / 2;
      return { x: p.x + half, y: p.y + half };
    },
    pixelToTile: (x, y) => renderer.pixelToTile(x, y),
    menuRects: () => {
      // Query the mounted DOM menu buttons and return their bounding rects.
      // Build entries win over action entries (only one menu is ever open, so
      // this just mirrors the old priority). `label` is the data-attr value.
      const build = Array.from(
        document.querySelectorAll<HTMLElement>('[data-build-entry]'),
      );
      if (build.length > 0) {
        return build.map((el) => rectFor(el, 'build', el.dataset.buildEntry ?? ''));
      }
      const action = Array.from(
        document.querySelectorAll<HTMLElement>('[data-menu-entry]'),
      );
      if (action.length > 0) {
        return action.map((el) => rectFor(el, 'action', el.dataset.menuEntry ?? ''));
      }
      return null;
    },
    animBusy,
    aiBusy,
    idle: () => !animBusy() && !aiBusy(),
    history,
  };

  // `globalThis` rather than `window` so this is safe under jsdom/node tests
  // that don't set a global `window`. main.ts only calls us in the browser.
  (globalThis as { __bats?: BatsDebug }).__bats = hook;
  return hook;
}
