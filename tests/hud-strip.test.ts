// @vitest-environment jsdom
//
// Mobile HUD strip (src/renderer/mobile/hud-strip.ts). The strip is a pure
// projection of the game state, so everything here is "set a state, read the
// DOM": the faction ribbon recolours through `data-player`, the Day counter
// converts plies to days, funds follow the CURRENT player (not a fixed one),
// the overview button drives the camera, and the AI turn gets its subdued
// marker. The measured-height callback is asserted too — main.ts feeds it
// straight into the renderer's board insets, so a silent regression there
// would letterbox the board.

import { describe, expect, it, beforeEach } from 'vitest';
import duelMap from '../src/data/maps/duel.json';
import { loadMap } from '../src/engine/data/loader';
import { createEmitter } from '../src/renderer/emitter';
import { createHudStrip } from '../src/renderer/mobile/hud-strip';
import type { AIDriver } from '../src/renderer/ai-driver';
import type { Camera } from '../src/renderer/camera';
import type { Emitter } from '../src/renderer/emitter';
import type { GameState } from '../src/engine/core/types';

function stubAIDriver(locked = false): AIDriver {
  return {
    getPlayerAI: () => 'human',
    setPlayerAI: () => {},
    inputLocked: () => locked,
    tick: () => {},
    busy: () => false,
  } as unknown as AIDriver;
}

function stubCamera(): Camera & { toggles: number; overview: boolean } {
  const cam = {
    toggles: 0,
    overview: false,
    toggleOverview(): void {
      cam.toggles += 1;
      cam.overview = !cam.overview;
    },
    isOverview: () => cam.overview,
  };
  return cam as unknown as Camera & { toggles: number; overview: boolean };
}

type Mounted = {
  emitter: Emitter;
  camera: Camera & { toggles: number; overview: boolean };
  insets: number[];
};

function mount(opts: { locked?: boolean } = {}): Mounted {
  document.body.innerHTML = '<div id="app"></div>';
  const emitter = createEmitter(loadMap(duelMap));
  const camera = stubCamera();
  const insets: number[] = [];
  createHudStrip({
    parent: document.getElementById('app')!,
    emitter,
    aiDriver: stubAIDriver(opts.locked ?? false),
    camera,
    onInsetsChange: (t) => insets.push(t),
  });
  return { emitter, camera, insets };
}

function q(sel: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}

function withPatch(state: GameState, patch: Partial<GameState>): GameState {
  return { ...structuredClone(state), ...patch };
}

describe('mobile HUD strip', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('ribbon names the acting faction and recolours through data-player', () => {
    const { emitter } = mount();
    const bar = q('.mhud');
    const ribbon = q('[data-hud-ribbon]');

    expect(bar.dataset.player).toBe('0');
    expect(ribbon.textContent).toBe('Vermilion to act');

    emitter.setState(withPatch(emitter.getState(), { currentPlayer: 1 }));
    expect(bar.dataset.player).toBe('1');
    expect(ribbon.textContent).toBe('Cobalt to act');
  });

  it('ribbon switches to the winner when the match concludes', () => {
    const { emitter } = mount();
    emitter.setState(withPatch(emitter.getState(), { currentPlayer: 0, winner: 1 }));
    expect(q('.mhud').dataset.player).toBe('1');
    expect(q('[data-hud-ribbon]').textContent).toBe('Cobalt victorious');
  });

  it('Day counter is ceil(turn / 2), zero-padded', () => {
    const { emitter } = mount();
    const day = q('[data-hud-day]');
    expect(emitter.getState().turn).toBe(1);
    expect(day.textContent).toBe('Day 01');

    emitter.setState(withPatch(emitter.getState(), { turn: 2 }));
    expect(day.textContent).toBe('Day 01');

    emitter.setState(withPatch(emitter.getState(), { turn: 3 }));
    expect(day.textContent).toBe('Day 02');

    emitter.setState(withPatch(emitter.getState(), { turn: 30 }));
    expect(day.textContent).toBe('Day 15');
  });

  it('funds track the CURRENT player, not a fixed side', () => {
    const { emitter } = mount();
    const funds = q('[data-hud-funds]');
    const s = structuredClone(emitter.getState());
    s.players[0].funds = 3000;
    s.players[1].funds = 12000;
    emitter.setState(s);
    expect(funds.textContent).toBe('◈ $3,000');

    emitter.setState(withPatch(emitter.getState(), { currentPlayer: 1 }));
    expect(funds.textContent).toBe('◈ $12,000');
  });

  it('overview button toggles the camera and reflects its state', () => {
    const { camera } = mount();
    const btn = q('[data-action="overview"]') as HTMLButtonElement;
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    btn.click();
    expect(camera.toggles).toBe(1);
    expect(camera.overview).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.classList.contains('on')).toBe(true);

    btn.click();
    expect(camera.toggles).toBe(2);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('omits the overview button when no camera is supplied', () => {
    document.body.innerHTML = '<div id="app"></div>';
    createHudStrip({
      parent: document.getElementById('app')!,
      emitter: createEmitter(loadMap(duelMap)),
      aiDriver: stubAIDriver(),
    });
    expect(document.querySelector('[data-action="overview"]')).toBeNull();
  });

  it('marks the strip subdued while an AI holds the turn', () => {
    const { emitter } = mount({ locked: true });
    expect(q('.mhud').dataset.ai).toBe('1');
    // A concluded match is not an "AI thinking" state, subdued clears.
    emitter.setState(withPatch(emitter.getState(), { winner: 0 }));
    expect(q('.mhud').dataset.ai).toBeUndefined();
  });

  it('reports its measured height once on mount', () => {
    const { insets } = mount();
    // jsdom lays nothing out (offsetHeight is 0), so the assertion is about the
    // callback contract firing at all — the real number arrives from the
    // ResizeObserver in a browser.
    expect(insets).toHaveLength(1);
    expect(insets[0]).toBe(0);
  });

  it('destroy() removes the strip and stops listening', () => {
    document.body.innerHTML = '<div id="app"></div>';
    const emitter = createEmitter(loadMap(duelMap));
    const strip = createHudStrip({
      parent: document.getElementById('app')!,
      emitter,
      aiDriver: stubAIDriver(),
    });
    expect(document.querySelector('.mhud')).not.toBeNull();
    strip.destroy();
    expect(document.querySelector('.mhud')).toBeNull();
    // No throw from a post-destroy emission.
    emitter.setState(withPatch(emitter.getState(), { currentPlayer: 1 }));
  });
});
