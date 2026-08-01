// @vitest-environment jsdom
//
// Skirmish stalemate rule — the UI-level day cap (src/renderer/adjudication.ts).
//
// The engine deliberately has no turn cap (src/engine/systems/win.ts: HQ
// capture or rout only) and that is not changing, so the rule lives in the
// shells. This suite pins the three things that make it a rule rather than a
// decoration:
//
//   1. past day 60 BOTH shells present the verdict — desktop through chrome's
//      winner overlay, mobile through the tray takeover;
//   2. it is skirmish-only: with `adjudicateStalemate: false` (what main.ts
//      passes for a campaign mission, which has its own `defeat.dayLimit`)
//      nothing happens at all;
//   3. `state.winner` is never forged — the overlay says "Adjudicated", and the
//      engine's own record of the match is left untouched.

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { createEmitter } from '../src/renderer/emitter';
import { createChrome } from '../src/renderer/chrome';
import { createTray } from '../src/renderer/mobile/tray';
import { createCanvasRenderer } from '../src/renderer/canvas';
import { createInputController } from '../src/renderer/input';
import { createAnimationQueue } from '../src/renderer/animations';
import { STALEMATE_DAY_CAP, stalemateReached } from '../src/renderer/adjudication';
import type { AIDriver } from '../src/renderer/ai-driver';
import type { AnimationQueue } from '../src/renderer/animations';
import type { AudioModule } from '../src/renderer/audio';
import type { Emitter } from '../src/renderer/emitter';
import type { InputController } from '../src/renderer/input';
import type { SpriteCache } from '../src/renderer/sprites';
import type { GameState, PlayerId } from '../src/engine/core/types';
import { makeState } from './test-helpers';

// ─────────────────────────── Stubs ───────────────────────────────────────────

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

function stubInput(): InputController {
  return {
    getState: () => ({ kind: 'idle' }),
    confirmStaged: () => {},
    cancel: () => {},
    toggleThreat: () => {},
    stageBuild: () => {},
    chooseAction: () => {},
  } as unknown as InputController;
}

function stubSprites(): SpriteCache {
  return { toDataURL: () => null } as unknown as SpriteCache;
}

// ─────────────────────────── Scenario ────────────────────────────────────────

/** First ply of the day after the cap. Day = ⌈turn/2⌉, so day 61 starts at
 *  ply 121 — the first state the rule is allowed to fire on. */
const PAST_CAP_TURN = STALEMATE_DAY_CAP * 2 + 1;
/** Last ply still inside the cap (day 60). */
const AT_CAP_TURN = STALEMATE_DAY_CAP * 2;

/**
 * A stand-off: both HQs held, one infantry each, nothing between them. The
 * ladder falls all the way through to a draw — which is the honest reading of
 * two armies that spent sixty days not fighting.
 */
function evenBoard(): GameState {
  return makeState({
    width: 8,
    height: 8,
    hqs: [
      { owner: 0, pos: { x: 0, y: 0 } },
      { owner: 1, pos: { x: 7, y: 7 } },
    ],
    units: [
      { type: 'infantry', owner: 0, pos: { x: 2, y: 2 } },
      { type: 'infantry', owner: 1, pos: { x: 5, y: 5 } },
    ],
  });
}

/** The same stand-off, but P0 has a tank where P1 has an infantry — the
 *  material rung decides for Vermilion. */
function p0AheadBoard(): GameState {
  return makeState({
    width: 8,
    height: 8,
    hqs: [
      { owner: 0, pos: { x: 0, y: 0 } },
      { owner: 1, pos: { x: 7, y: 7 } },
    ],
    units: [
      { type: 'tank', owner: 0, pos: { x: 2, y: 2 } },
      { type: 'infantry', owner: 1, pos: { x: 5, y: 5 } },
    ],
  });
}

function at(state: GameState, turn: number): GameState {
  return { ...structuredClone(state), turn };
}

function q<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}

// ─────────────────────────── Desktop chrome ──────────────────────────────────

function mountChrome(
  state: GameState,
  opts: { adjudicateStalemate?: boolean } = {},
): Emitter {
  document.body.innerHTML = '<div id="app"></div>';
  const emitter = createEmitter(state);
  createChrome({
    parent: document.getElementById('app')!,
    emitter,
    aiDriver: stubAIDriver(),
    animQueue: stubAnimQueue(),
    audio: stubAudio(),
    ...(opts.adjudicateStalemate !== undefined
      ? { adjudicateStalemate: opts.adjudicateStalemate }
      : {}),
  });
  return emitter;
}

describe('chrome — day-cap adjudication overlay', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('stays hidden at the cap and appears the ply after it', () => {
    const emitter = mountChrome(at(evenBoard(), AT_CAP_TURN));
    const overlay = q('.winner-overlay');
    expect(overlay.hidden).toBe(true);

    emitter.setState(at(evenBoard(), PAST_CAP_TURN));
    expect(overlay.hidden).toBe(false);
  });

  it('reads "Adjudicated / Draw" on an even board — not a victory', () => {
    mountChrome(at(evenBoard(), PAST_CAP_TURN));
    expect(q('.winner-eyebrow').textContent).toBe('Adjudicated');
    expect(q('.winner-title').textContent).toBe('Draw');
    expect(q('.winner-subtitle').textContent).toContain('Neither side could force');
    // No side to accent.
    expect(q('.winner-overlay').dataset.player).toBeUndefined();
    expect(q('.winner-overlay').dataset.adjudicated).toBe('');
  });

  it('names the side that was ahead when the ladder can separate them', () => {
    mountChrome(at(p0AheadBoard(), PAST_CAP_TURN));
    expect(q('.winner-title').textContent).toBe('Vermilion prevails');
    expect(q('.winner-overlay').dataset.player).toBe('0');
  });

  it('never forges state.winner — the engine record is untouched', () => {
    const emitter = mountChrome(at(p0AheadBoard(), PAST_CAP_TURN));
    expect(emitter.getState().winner).toBeNull();
  });

  it('blocks further play: End Turn is disabled and inert', () => {
    const emitter = mountChrome(at(evenBoard(), PAST_CAP_TURN));
    const dispatched: string[] = [];
    emitter.on((ev) => {
      if (ev.type === 'stateChanged' && ev.action !== null) dispatched.push(ev.action.type);
    });
    const endTurn = q<HTMLButtonElement>('[data-action="end-turn"]');
    expect(endTurn.disabled).toBe(true);
    endTurn.click();
    expect(dispatched).toEqual([]);
  });

  it('withholds Dismiss (the scrim is doing the blocking) but offers Play Again', () => {
    mountChrome(at(evenBoard(), PAST_CAP_TURN));
    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>('.winner-buttons .tool'),
    );
    const visible = buttons.filter((b) => !b.hidden).map((b) => b.textContent);
    expect(visible.some((t) => t?.includes('Play Again'))).toBe(true);
    expect(visible.some((t) => t?.includes('Dismiss'))).toBe(false);
  });

  it('a real win still reads "Match Concluded" with Dismiss offered', () => {
    const won = at(evenBoard(), PAST_CAP_TURN);
    won.winner = 0 as PlayerId;
    mountChrome(won);
    expect(q('.winner-eyebrow').textContent).toBe('Match Concluded');
    expect(q('.winner-title').textContent).toBe('Vermilion victorious');
    expect(q('.winner-overlay').dataset.adjudicated).toBeUndefined();
    const dismiss = Array.from(
      document.querySelectorAll<HTMLElement>('.winner-buttons .tool'),
    ).find((b) => b.textContent?.includes('Dismiss'))!;
    expect(dismiss.hidden).toBe(false);
  });

  it('does NOT fire during a campaign mission (adjudicateStalemate: false)', () => {
    mountChrome(at(evenBoard(), PAST_CAP_TURN), { adjudicateStalemate: false });
    expect(q('.winner-overlay').hidden).toBe(true);
    expect(q<HTMLButtonElement>('[data-action="end-turn"]').disabled).toBe(false);
  });

  it('a campaign mission that IS won past the cap still shows the real victory', () => {
    const won = at(evenBoard(), PAST_CAP_TURN);
    won.winner = 1 as PlayerId;
    mountChrome(won, { adjudicateStalemate: false });
    expect(q('.winner-overlay').hidden).toBe(false);
    expect(q('.winner-title').textContent).toBe('Cobalt victorious');
  });
});

// ─────────────────────────── Mobile tray ─────────────────────────────────────

function mountTray(
  state: GameState,
  opts: { adjudicateStalemate?: boolean } = {},
): Emitter {
  document.body.innerHTML = '<div id="app"></div>';
  const emitter = createEmitter(state);
  createTray({
    parent: document.getElementById('app')!,
    emitter,
    input: stubInput(),
    aiDriver: stubAIDriver(),
    animQueue: stubAnimQueue(),
    audio: stubAudio(),
    sprites: stubSprites(),
    ...(opts.adjudicateStalemate !== undefined
      ? { adjudicateStalemate: opts.adjudicateStalemate }
      : {}),
  });
  return emitter;
}

function trayState(): string {
  return q('.tray').dataset.trayState ?? '';
}

describe('tray — day-cap adjudication takeover', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('stays on the input node at the cap and takes over the ply after it', () => {
    const emitter = mountTray(at(evenBoard(), AT_CAP_TURN));
    expect(trayState()).toBe('idle');

    emitter.setState(at(evenBoard(), PAST_CAP_TURN));
    expect(trayState()).toBe('adjudicated');
  });

  it('reads "Adjudicated / Draw" and swaps End Turn for Play Again', () => {
    mountTray(at(evenBoard(), PAST_CAP_TURN));
    expect(q('.tray-comp-eyebrow').textContent).toBe('Adjudicated');
    expect(q('.tray-comp-title').textContent).toBe('Draw');
    expect(q('[data-tray-hint]').textContent).toContain('Neither side could force');
    expect(document.querySelector('[data-action="end-turn"]')).toBeNull();
    expect(document.querySelector('[data-action="play-again"]')).not.toBeNull();
  });

  it('names the side that was ahead, and accents it', () => {
    mountTray(at(p0AheadBoard(), PAST_CAP_TURN));
    expect(q('.tray-comp-title').textContent).toBe('Vermilion prevails');
    expect(q('.tray-complete').dataset.player).toBe('0');
  });

  it('never forges state.winner', () => {
    const emitter = mountTray(at(p0AheadBoard(), PAST_CAP_TURN));
    expect(emitter.getState().winner).toBeNull();
  });

  it('a real win still takes the winner takeover, not the adjudicated one', () => {
    const won = at(evenBoard(), PAST_CAP_TURN);
    won.winner = 0 as PlayerId;
    mountTray(won);
    expect(trayState()).toBe('winner');
    expect(q('.tray-comp-title').textContent).toBe('Vermilion victorious');
  });

  it('does NOT fire during a campaign mission (adjudicateStalemate: false)', () => {
    mountTray(at(evenBoard(), PAST_CAP_TURN), { adjudicateStalemate: false });
    expect(trayState()).toBe('idle');
    expect(document.querySelector('[data-action="end-turn"]')).not.toBeNull();
    expect(document.querySelector('[data-action="play-again"]')).toBeNull();
  });
});

// ─────────────────────────── Board lock ──────────────────────────────────────
//
// Mobile deliberately mounts no modal scrim (tray.ts), so the tray takeover
// alone would leave the board tappable behind it. The lock therefore lives in
// the input controller's `matchConcluded` predicate, which main.ts wires to the
// same day cap — this is the part that makes it a rule on both shells.

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

/** main.ts's predicate, verbatim: skirmish-only, day-cap-driven. */
function concludedPredicate(emitter: Emitter, adjudicateStalemate: boolean) {
  return (): boolean => adjudicateStalemate && stalemateReached(emitter.getState());
}

function mountInput(state: GameState, adjudicateStalemate: boolean) {
  document.body.innerHTML = '<div id="app"></div>';
  const canvas = document.createElement('canvas');
  document.getElementById('app')!.appendChild(canvas);
  canvas.getContext = (type: string) =>
    (type === '2d' ? makeCtxStub() : null) as never;
  const emitter = createEmitter(state);
  const renderer = createCanvasRenderer(canvas);
  renderer.resize();
  const animQueue = createAnimationQueue({ now: () => 0 });
  const input = createInputController(renderer, emitter, animQueue, {
    matchConcluded: concludedPredicate(emitter, adjudicateStalemate),
  });
  return { emitter, renderer, input };
}

describe('input — the adjudicated board is dead', () => {
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
    document.body.innerHTML = '';
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
  });

  function clickOwnUnit(m: ReturnType<typeof mountInput>): void {
    const unit = Object.values(m.emitter.getState().units).find((u) => u.owner === 0)!;
    const ts = m.renderer.getViewport().tileSize;
    const px = m.renderer.tileToPixel(unit.pos);
    m.input.click(px.x + ts / 2, px.y + ts / 2);
  }

  it('past the cap a tile click selects nothing', () => {
    const m = mountInput(at(evenBoard(), PAST_CAP_TURN), true);
    clickOwnUnit(m);
    expect(m.input.getState().kind).toBe('idle');
  });

  it('at the cap the board is still live', () => {
    const m = mountInput(at(evenBoard(), AT_CAP_TURN), true);
    clickOwnUnit(m);
    expect(m.input.getState().kind).toBe('unit-selected');
  });

  it('a campaign mission past day 60 is still playable', () => {
    const m = mountInput(at(evenBoard(), PAST_CAP_TURN), false);
    clickOwnUnit(m);
    expect(m.input.getState().kind).toBe('unit-selected');
  });
});
