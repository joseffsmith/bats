// @vitest-environment jsdom
//
// DOM menus (src/renderer/menus.ts) — the Phase 2.3 replacement for the canvas
// action/build popovers. Covers:
//   - action entries render as [data-menu-entry] buttons, disabled state honoured,
//     click calls input.chooseAction with the label;
//   - build entries render as [data-build-entry] buttons, unaffordable disabled,
//     click calls input.chooseBuild with the unit type;
//   - the 14-entry coastal roster is fully present in a single scrollable
//     container (the regression the old canvas hud-layout test guarded — every
//     entry reachable — now expressed as "all 14 buttons live in the DOM list"
//     rather than geometric column wrapping);
//   - coarse pointer flips the build menu to a bottom sheet;
//   - closing the menu clears the DOM.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createEmitter } from '../src/renderer/emitter';
import { createMenus } from '../src/renderer/menus';
import type { CanvasRenderer, Overlay, BuildMenuEntry } from '../src/renderer/canvas';
import type { InputController } from '../src/renderer/input';
import type { Emitter } from '../src/renderer/emitter';
import type { SpriteCache } from '../src/renderer/sprites';
import { makeState } from './test-helpers';

/** Sprite cache stub in "no data URL" mode → build entries use the letter chip
 *  fallback, which is what these DOM-structure assertions target. */
function makeSpritesStub(): SpriteCache {
  return { toDataURL: () => null } as unknown as SpriteCache;
}

function makeRendererStub(): CanvasRenderer {
  return {
    tileToPixel: (c: { x: number; y: number }) => ({ x: c.x * 48, y: c.y * 48 }),
    getViewport: () => ({
      width: 1024,
      height: 768,
      dpr: 1,
      tileSize: 48,
      origin: { x: 0, y: 0 },
      insetTop: 110,
      insetBottom: 110,
    }),
  } as unknown as CanvasRenderer;
}

/** A stub input controller whose overlay + choose spies the tests drive. */
function makeInputStub(): {
  input: InputController;
  setOverlay(ov: Overlay): void;
  actions: string[];
  builds: string[];
} {
  let overlay: Overlay = {};
  const actions: string[] = [];
  const builds: string[] = [];
  const input = {
    getOverlay: () => overlay,
    chooseAction: (label: string) => actions.push(label),
    chooseBuild: (unitType: string) => builds.push(unitType),
  } as unknown as InputController;
  return { input, setOverlay: (ov) => (overlay = ov), actions, builds };
}

function build14(coastalAffordable: boolean): BuildMenuEntry[] {
  const types = [
    'infantry', 'recon', 'tank', 'artillery', 'aatank', 'copter', 'fighter',
    'bomber', 'transport', 'lander', 'cruiser', 'battleship', 'submarine', 'carrier',
  ] as const;
  return types.map((t, i) => ({
    unitType: t,
    label: t,
    cost: 1000 + i * 500,
    // Make the last one unaffordable so we can assert the disabled path too.
    affordable: coastalAffordable && i < types.length - 1,
  }));
}

describe('DOM menus', () => {
  let emitter: Emitter;
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById('app')!;
    emitter = createEmitter(
      makeState({
        width: 4,
        height: 1,
        hqs: [
          { owner: 0, pos: { x: 0, y: 0 } },
          { owner: 1, pos: { x: 3, y: 0 } },
        ],
        units: [],
      }),
    );
  });

  afterEach(() => {
    // Reset any matchMedia stub between tests.
    // @ts-expect-error — deleting the stubbed override.
    delete window.matchMedia;
  });

  it('renders action entries and routes clicks to chooseAction', () => {
    const { input, setOverlay, actions } = makeInputStub();
    setOverlay({
      actionMenu: {
        tile: { x: 1, y: 0 },
        entries: [
          { label: 'Attack', enabled: true },
          { label: 'Wait', enabled: true },
          { label: 'Capture', enabled: false },
        ],
      },
    });
    const menus = createMenus({ parent: root, emitter, input, renderer: makeRendererStub(), sprites: makeSpritesStub() });

    const btns = root.querySelectorAll<HTMLButtonElement>('[data-menu-entry]');
    expect(btns).toHaveLength(3);
    const capture = root.querySelector<HTMLButtonElement>('[data-menu-entry="Capture"]')!;
    expect(capture.disabled).toBe(true);

    root.querySelector<HTMLButtonElement>('[data-menu-entry="Attack"]')!.click();
    expect(actions).toEqual(['Attack']);
    menus.destroy();
  });

  it('renders all 14 build entries in one list; last is unaffordable/disabled', () => {
    const { input, setOverlay, builds } = makeInputStub();
    setOverlay({
      buildMenu: { tile: { x: 1, y: 0 }, entries: build14(true) },
    });
    createMenus({ parent: root, emitter, input, renderer: makeRendererStub(), sprites: makeSpritesStub() });

    const btns = root.querySelectorAll<HTMLButtonElement>('[data-build-entry]');
    expect(btns).toHaveLength(14);
    // Every entry lives inside a single scroll list — all reachable, no clipping.
    const list = root.querySelector('.menu-build-list')!;
    expect(list.querySelectorAll('[data-build-entry]')).toHaveLength(14);

    const carrier = root.querySelector<HTMLButtonElement>('[data-build-entry="carrier"]')!;
    expect(carrier.disabled).toBe(true); // made unaffordable in build14

    root.querySelector<HTMLButtonElement>('[data-build-entry="tank"]')!.click();
    expect(builds).toEqual(['tank']);
  });

  it('coarse pointer flips the build menu to a bottom sheet, still 14 entries', () => {
    // Stub matchMedia → coarse.
    window.matchMedia = ((): MediaQueryList =>
      ({ matches: true }) as MediaQueryList) as typeof window.matchMedia;
    const { input, setOverlay } = makeInputStub();
    setOverlay({
      buildMenu: { tile: { x: 1, y: 0 }, entries: build14(true) },
    });
    createMenus({ parent: root, emitter, input, renderer: makeRendererStub(), sprites: makeSpritesStub() });

    expect(root.querySelector('.menu-sheet')).not.toBeNull();
    expect(root.querySelectorAll('[data-build-entry]')).toHaveLength(14);
  });

  it('re-renders on emitter stateChanged and clears when the menu closes', () => {
    const { input, setOverlay } = makeInputStub();
    setOverlay({ buildMenu: { tile: { x: 1, y: 0 }, entries: build14(true) } });
    createMenus({ parent: root, emitter, input, renderer: makeRendererStub(), sprites: makeSpritesStub() });
    expect(root.querySelectorAll('[data-build-entry]')).toHaveLength(14);

    // Close the menu (idle overlay) and fire a transition — the DOM clears.
    setOverlay({});
    emitter.emit({ type: 'inputStateChanged', kind: 'idle' });
    // inputStateChanged alone doesn't drive menus (they listen on stateChanged);
    // the input controller always emits BOTH, so simulate the stateChanged too.
    emitter.emit({ type: 'stateChanged', state: emitter.getState(), action: null });
    expect(root.querySelectorAll('[data-build-entry]')).toHaveLength(0);
  });
});
