// @vitest-environment jsdom
//
// Regression tests for the END_TURN turn-steal bug.
//
// Background: a human Enter press or End Turn click during an AI turn used to
// dispatch END_TURN with no guard. That flipped currentPlayer to the human
// while the driver kept draining the AI's already-planned actions — the unit
// actions were rejected by validators, but the plan's *trailing* END_TURN (
// always legal) then ended the HUMAN's turn. One keystroke skipped a whole
// human turn.
//
// Two coordinated fixes are covered here:
//   (1) the driver abandons a pending plan the moment currentPlayer changes
//       out from under it (the backstop against ANY external END_TURN source);
//   (2) the input controller's Enter keybind honours an `endTurnAllowed`
//       predicate so it can be suppressed during AI turns / animations.

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { createEmitter } from '../src/renderer/emitter';
import { createCanvasRenderer } from '../src/renderer/canvas';
import { createInputController } from '../src/renderer/input';
import { createAnimationQueue } from '../src/renderer/animations';
import { createAIDriver } from '../src/renderer/ai-driver';
import { makeState } from './test-helpers';
import type { GameState } from '../src/engine/core/types';

// ─── Task 1a: driver backstop ────────────────────────────────────────────────

describe('AIDriver abandons a stale plan when currentPlayer changes underneath it', () => {
  it('does not dispatch player-1 actions — nor let the trailing END_TURN steal player 0 — after an external END_TURN', () => {
    // Player 1 gets several units so the random plan is long enough to catch
    // genuinely mid-flight. Player 0 is human.
    const state = makeState({
      width: 10,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 9, y: 2 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 1 } },
        { type: 'infantry', owner: 1, pos: { x: 5, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 6, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 7, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 5, y: 2 } },
      ],
    });
    const emitter = createEmitter(state);
    let nowMs = 0;
    const now = (): number => nowMs;
    // The queue shares the driver's clock so animations expire deterministically
    // as we wind the clock forward between ticks.
    const animQueue = createAnimationQueue({ now });
    const driver = createAIDriver({
      emitter,
      animQueue,
      initial: { 0: 'human', 1: 'random' },
      pauseMs: 0,
      seed: 1,
      now,
    });

    // Count driver dispatches so we can (a) detect mid-flight and (b) prove the
    // driver stays silent once the plan is abandoned. `flipped` marks the moment
    // the human's stray END_TURN lands.
    let flipped = false;
    let actionsAfterFlip = 0;
    const unsub = emitter.on((ev) => {
      if (ev.type === 'stateChanged' && ev.action !== null && flipped) {
        actionsAfterFlip++;
      }
    });

    // The human ends their own turn → it becomes the AI's (player 1) turn.
    emitter.dispatch({ type: 'END_TURN' });
    expect(emitter.getState().currentPlayer).toBe(1);

    // Tick until the driver has planned and dispatched at least one of player
    // 1's actions while more remain queued (plan mid-flight).
    let guard = 0;
    let dispatchedOne = false;
    const seen = emitter.on((ev) => {
      if (ev.type === 'stateChanged' && ev.action !== null) dispatchedOne = true;
    });
    while (guard < 500 && !(dispatchedOne && driver.busy())) {
      animQueue.tick();
      driver.tick();
      nowMs += 2000; // far past any enqueued animation's duration
      guard++;
    }
    seen();
    expect(driver.busy()).toBe(true);
    expect(emitter.getState().currentPlayer).toBe(1);

    // The human presses Enter mid-AI-turn: END_TURN flips currentPlayer to 0.
    // (This event fires while `flipped` is still false, so it isn't counted.)
    emitter.dispatch({ type: 'END_TURN' });
    flipped = true;
    expect(emitter.getState().currentPlayer).toBe(0);

    // Keep ticking. The backstop must abandon the remaining plan without
    // dispatching any player-1 action, and must never let the trailing END_TURN
    // flip control back to player 1.
    for (let i = 0; i < 50; i++) {
      animQueue.tick();
      driver.tick();
      nowMs += 2000;
      expect(emitter.getState().currentPlayer).toBe(0);
    }
    unsub();

    expect(actionsAfterFlip).toBe(0);
    expect(driver.busy()).toBe(false);
  }, 30_000);
});

// ─── Task 1b: input controller Enter guard ───────────────────────────────────

function makeCtxStub(): CanvasRenderingContext2D {
  const noop = (): void => {};
  const stub: Record<string, unknown> = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    globalAlpha: 1,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    fillText: noop,
    setTransform: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
  };
  return stub as unknown as CanvasRenderingContext2D;
}

function mount(state: GameState) {
  document.body.innerHTML = '<div id="app"></div>';
  const canvas = document.createElement('canvas');
  document.getElementById('app')!.appendChild(canvas);
  canvas.getContext = (type: string) =>
    (type === '2d' ? makeCtxStub() : null) as never;
  const emitter = createEmitter(state);
  const renderer = createCanvasRenderer(canvas);
  renderer.resize();
  const animQueue = createAnimationQueue({ now: () => 0 });
  return { canvas, emitter, renderer, animQueue };
}

function simpleState(): GameState {
  return makeState({
    width: 5,
    height: 1,
    defaultTerrain: 'plain',
    hqs: [
      { owner: 0, pos: { x: 0, y: 0 } },
      { owner: 1, pos: { x: 4, y: 0 } },
    ],
    units: [{ type: 'infantry', owner: 0, pos: { x: 2, y: 0 } }],
  });
}

describe('input controller Enter keybind honours endTurnAllowed', () => {
  beforeAll(() => {
    const orig = console.error.bind(console);
    console.error = (...args: unknown[]): void => {
      if (
        typeof args[0] === 'string' &&
        args[0].includes("HTMLCanvasElement's getContext")
      ) {
        return;
      }
      orig(...(args as []));
    };
  });

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
  });

  it('does NOT dispatch END_TURN on Enter when endTurnAllowed() is false', () => {
    const { emitter, renderer, animQueue } = mount(simpleState());
    createInputController(renderer, emitter, animQueue, {
      endTurnAllowed: () => false,
    });
    expect(emitter.getState().currentPlayer).toBe(0);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    // Turn must not advance — the guard suppressed END_TURN.
    expect(emitter.getState().currentPlayer).toBe(0);
    expect(emitter.getState().turn).toBe(1);
  });

  it('DOES dispatch END_TURN on Enter with default opts (always allowed)', () => {
    const { emitter, renderer, animQueue } = mount(simpleState());
    createInputController(renderer, emitter, animQueue);
    expect(emitter.getState().currentPlayer).toBe(0);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(emitter.getState().currentPlayer).toBe(1);
  });
});
