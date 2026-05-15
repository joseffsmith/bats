// @vitest-environment jsdom
//
// Renderer-side persona wiring: `AI_CHOICES` must expose every persona name
// (so the chrome controllers strip renders them) and `createAIDriver` must
// be able to construct a driver for a persona without throwing. We also
// verify the driver dispatches at least one legal action for the persona.

import { describe, expect, it } from 'vitest';
import duelMap from '../src/data/maps/duel.json';
import { loadMap } from '../src/engine/data/loader';
import { createEmitter } from '../src/renderer/emitter';
import { createAnimationQueue } from '../src/renderer/animations';
import {
  AI_CHOICES,
  AI_PERSONA_CHOICES,
  createAIDriver,
} from '../src/renderer/ai-driver';

const REQUIRED_PERSONAS = ['aggressor', 'turtle', 'economist', 'balanced'] as const;

describe('AI_CHOICES exposes persona names', () => {
  it('contains every required persona', () => {
    for (const name of REQUIRED_PERSONAS) {
      expect(AI_CHOICES).toContain(name);
    }
  });

  it('order: human, random, utility, then personas', () => {
    expect(AI_CHOICES[0]).toBe('human');
    expect(AI_CHOICES[1]).toBe('random');
    expect(AI_CHOICES[2]).toBe('utility');
  });

  it('AI_PERSONA_CHOICES is exactly the four personas', () => {
    expect([...AI_PERSONA_CHOICES].sort()).toEqual([...REQUIRED_PERSONAS].sort());
  });
});

describe('AIDriver construction with persona', () => {
  it('aggressor persona constructs and produces valid actions for player 0', () => {
    const state = loadMap(duelMap);
    const emitter = createEmitter(state);
    let nowMs = 0;
    const now = (): number => nowMs;
    // Animation queue uses the same clock as the driver so we can advance
    // both deterministically. With pauseMs=0 the driver gates only on the
    // queue's `busy()`, so animations must complete promptly between ticks.
    const animQueue = createAnimationQueue({ now });

    const driver = createAIDriver({
      emitter,
      animQueue,
      initial: { 0: 'aggressor', 1: 'human' },
      pauseMs: 0,
      seed: 1,
      now,
    });

    // Currently player 0's turn; aggressor is non-human → driver should
    // claim input lock.
    expect(driver.inputLocked(emitter.getState())).toBe(true);

    // First tick plans the turn; subsequent ticks dispatch actions one at
    // a time. Wind the clock forward (a generous step) so any enqueued
    // animations expire between ticks, and tick repeatedly until END_TURN
    // flips currentPlayer.
    let iterations = 0;
    const initialPlayer = emitter.getState().currentPlayer;
    let dispatched = 0;
    const unsub = emitter.on((ev) => {
      if (ev.type === 'stateChanged' && ev.action !== null) dispatched++;
    });
    while (
      iterations < 2000 &&
      emitter.getState().currentPlayer === initialPlayer &&
      emitter.getState().winner === null
    ) {
      animQueue.tick();
      driver.tick();
      nowMs += 2000; // far past any animation duration
      iterations++;
    }
    unsub();

    // Player 0's turn must have ended (or the game finished — unlikely
    // turn 1, but accept either as a valid terminal).
    const s = emitter.getState();
    expect(
      s.currentPlayer !== initialPlayer || s.winner !== null,
    ).toBe(true);
    // The persona produced at least one dispatched action (at minimum END_TURN).
    expect(dispatched).toBeGreaterThan(0);
  }, 30_000);

  it.each([...REQUIRED_PERSONAS])(
    'persona "%s" wires through makeAI without throwing',
    (persona) => {
      const state = loadMap(duelMap);
      const emitter = createEmitter(state);
      const animQueue = createAnimationQueue({ now: () => 0 });
      const driver = createAIDriver({
        emitter,
        animQueue,
        initial: { 0: persona, 1: 'human' },
        pauseMs: 0,
        seed: 1,
        now: () => 0,
      });
      expect(driver.getPlayerAI(0)).toBe(persona);
      // Single tick mustn't blow up — it should plan internally.
      expect(() => driver.tick()).not.toThrow();
    },
  );
});
