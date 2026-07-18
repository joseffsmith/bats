// @vitest-environment jsdom
//
// DOM chrome (src/renderer/chrome.ts) — the player-facing surfaces this QoL pass
// touched:
//   - the AW-style Day counter. The engine increments `state.turn` on every
//     END_TURN (a ply); the header shows Day = ⌈turn/2⌉ (plies 1 & 2 → Day 01,
//     ply 3 → Day 02). The engine + replay/debug surfaces keep raw plies.
//   - the singular/plural units stat label ("1 UNIT" vs "0/2 UNITS").

import { describe, expect, it, beforeEach } from 'vitest';
import duelMap from '../src/data/maps/duel.json';
import { loadMap } from '../src/engine/data/loader';
import { createEmitter } from '../src/renderer/emitter';
import { createChrome } from '../src/renderer/chrome';
import type { AIDriver } from '../src/renderer/ai-driver';
import type { AnimationQueue } from '../src/renderer/animations';
import type { AudioModule } from '../src/renderer/audio';
import type { Emitter } from '../src/renderer/emitter';
import type { GameState } from '../src/engine/core/types';

function stubAIDriver(): AIDriver {
  return {
    getPlayerAI: () => 'human',
    setPlayerAI: () => {},
    inputLocked: () => false,
    tick: () => {},
    busy: () => false,
  } as unknown as AIDriver;
}

function stubAnimQueue(): AnimationQueue {
  return { busy: () => false } as unknown as AnimationQueue;
}

function stubAudio(): AudioModule {
  return {
    isMuted: () => true,
    setMuted: () => {},
    unlock: () => {},
    onAction: () => {},
  } as unknown as AudioModule;
}

function mount(): { emitter: Emitter } {
  document.body.innerHTML = '<div id="app"></div>';
  const emitter = createEmitter(loadMap(duelMap));
  createChrome({
    parent: document.getElementById('app')!,
    emitter,
    aiDriver: stubAIDriver(),
    animQueue: stubAnimQueue(),
    audio: stubAudio(),
  });
  return { emitter };
}

function withTurn(state: GameState, turn: number): GameState {
  return { ...structuredClone(state), turn };
}

describe('chrome Day counter (display-only; engine keeps plies)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows Day 01 at ply 1 and ply 2, Day 02 at ply 3', () => {
    const { emitter } = mount();
    const turnN = document.querySelector('.turn-n')!;
    // Boot is ply 1.
    expect(emitter.getState().turn).toBe(1);
    expect(turnN.textContent).toBe('Day 01');

    emitter.setState(withTurn(emitter.getState(), 2));
    expect(turnN.textContent).toBe('Day 01');

    emitter.setState(withTurn(emitter.getState(), 3));
    expect(turnN.textContent).toBe('Day 02');
  });

  it('winner subtitle reports the day, not the raw ply', () => {
    const { emitter } = mount();
    const won: GameState = {
      ...structuredClone(emitter.getState()),
      turn: 30,
      winner: 0,
    };
    emitter.setState(won);
    const subtitle = document.querySelector('.winner-subtitle')!;
    expect(subtitle.textContent).toBe('Player 1 captured the field on day 15.');
  });
});

describe('chrome units label pluralization', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders singular "Unit" at a count of 1 (duel boot: one infantry each)', () => {
    const { emitter } = mount();
    // The first .player-panel is player 0's; duel gives each side one infantry.
    const label = document.querySelector('.stat-units .k')!;
    expect(emitter.getState().turn).toBe(1);
    expect(label.textContent).toBe('Unit');
  });

  it('renders plural "Units" at a count of 0', () => {
    const { emitter } = mount();
    const label = document.querySelector('.stat-units .k')!;
    emitter.setState({ ...structuredClone(emitter.getState()), units: {} });
    expect(label.textContent).toBe('Units');
  });

  it('renders plural "Units" at a count of 2', () => {
    const { emitter } = mount();
    const label = document.querySelector('.stat-units .k')!;
    const s = structuredClone(emitter.getState());
    const p0 = Object.values(s.units).find((u) => u.owner === 0)!;
    const clone = { ...structuredClone(p0), id: 'clone-unit' };
    s.units = { [p0.id]: p0, [clone.id]: clone };
    emitter.setState(s);
    expect(label.textContent).toBe('Units');
  });
});
