// Renderer-side AI driver.
//
// Owns the policy that lets a configured AI take over a player's turn in the
// live game. Decoupled from the engine reducer (the AI sees only fresh
// `getState()` snapshots) and decoupled from the DOM HUD (the DOM panel
// flips a per-player option on this driver via setPlayerAI).
//
// Behaviour:
// - When `tick()` is called and `state.currentPlayer`'s AI is non-human and
//   the animation queue is idle, we ask the AI for one turn's worth of actions
//   and start dispatching them with a short delay between dispatches so the
//   human can see what happened.
// - Between dispatches we enqueue the matching renderer animations so the
//   move shows on-screen.
// - If `state.winner !== null` — or the caller's `matchConcluded` predicate
//   says the match has been adjudicated at the skirmish day cap — the driver
//   does nothing.

import type { Action, GameState, PlayerId } from '../engine/core/types';
import { createRng } from '../engine/core/rng';
import type { Rng } from '../engine/core/rng';
import { enqueueAttackEffects } from './attack-effects';
import { utilityAI } from '../engine/ai/utility';
import { randomAI } from '../engine/ai/random';
import { personaAI } from '../engine/ai/personas';
import type { AI } from '../engine/ai/types';
import type { Emitter } from './emitter';
import type { AnimationQueue } from './animations';
import { log } from '../engine/core/logger';

export type AIChoice =
  | 'human'
  | 'random'
  | 'utility'
  | 'aggressor'
  | 'turtle'
  | 'economist'
  | 'balanced';

/** Persona names exposed via the controller dropdown. Keep in sync with
 *  `src/data/ai-personas.json` — the other agent maintains that file. */
export const AI_PERSONA_CHOICES: ReadonlyArray<AIChoice> = [
  'aggressor',
  'turtle',
  'economist',
  'balanced',
];

export const AI_CHOICES: ReadonlyArray<AIChoice> = [
  'human',
  'random',
  'utility',
  ...AI_PERSONA_CHOICES,
];

export type AIDriverDeps = {
  emitter: Emitter;
  animQueue: AnimationQueue;
  /** ms between AI actions for visibility. */
  pauseMs?: number;
  /** Initial per-player AI choices. */
  initial?: Record<PlayerId, AIChoice>;
  /** RNG seed for the driver. Default `Date.now()`. */
  seed?: number;
  /** Time source — `performance.now` in the browser, `Date.now` in tests. */
  now?: () => number;
  /** When true, AI plans under fog-of-war (filtered enemy reads). */
  fog?: boolean;
  /** Extra "the match is over" predicate, ORed into the `state.winner` guard.
   *  main.ts wires the skirmish day cap (src/renderer/adjudication.ts) here:
   *  once a stand-off has been adjudicated the AI must stop playing, or it
   *  would keep taking turns behind the verdict overlay. Defaults to false. */
  matchConcluded?: () => boolean;
};

export type AIDriver = {
  /** Update the chosen AI for a player. Pass 'human' to hand control back. */
  setPlayerAI(player: PlayerId, choice: AIChoice): void;
  getPlayerAI(player: PlayerId): AIChoice;
  /** Should the renderer disable mouse input? True iff the current player is AI-controlled. */
  inputLocked(state: GameState): boolean;
  /** Driven by the render loop. Decides whether to fire the next AI action. */
  tick(): void;
  /** True iff an AI plan is currently being played out. */
  busy(): boolean;
};

export function createAIDriver(deps: AIDriverDeps): AIDriver {
  const pauseMs = deps.pauseMs ?? 250;
  const now = deps.now ?? ((): number => performance.now());
  const seed = deps.seed ?? Date.now();
  const rng: Rng = createRng(seed);
  const fog = deps.fog ?? false;
  const matchConcluded = deps.matchConcluded ?? ((): boolean => false);

  const choices: Record<PlayerId, AIChoice> = {
    0: deps.initial?.[0] ?? 'human',
    1: deps.initial?.[1] ?? 'human',
  };

  // A current "plan" — actions yet to dispatch for the active AI turn.
  let pendingPlan: Action[] = [];
  let nextActionAt = 0;
  /** Player whose plan is currently being executed (may differ from current
   * after END_TURN is dispatched). */
  let planOwner: PlayerId | null = null;

  function makeAI(choice: AIChoice): AI | null {
    if (choice === 'human') return null;
    if (choice === 'random') return randomAI({ name: 'random' });
    if (choice === 'utility') return utilityAI({ name: 'utility', fog });
    // Otherwise it's a persona name — defer to the persona factory.
    return personaAI(choice, { fog });
  }

  function planTurnIfNeeded(): void {
    const state = deps.emitter.getState();
    if (state.winner !== null || matchConcluded()) return;
    if (pendingPlan.length > 0) return;
    const player = state.currentPlayer;
    const choice = choices[player];
    if (choice === 'human') return;
    const ai = makeAI(choice);
    if (!ai) return;
    log('ai', 'driver plan request', { player, ai: ai.name, turn: state.turn });
    const plan = ai.takeTurn({ state, player, rng });
    pendingPlan = plan;
    planOwner = player;
    nextActionAt = now() + pauseMs;
  }

  function dispatchNext(): void {
    if (pendingPlan.length === 0) return;
    // The day cap can trip mid-plan (the AI's own END_TURN is what rolls the
    // day over). Drop the remainder rather than playing on under the verdict.
    if (matchConcluded()) {
      pendingPlan = [];
      planOwner = null;
      return;
    }
    // Backstop against ANY external END_TURN source (human Enter key, the End
    // Turn button) that flipped currentPlayer out from under a plan we're still
    // draining. Without this guard the stale unit actions merely get rejected
    // by the validators, but the plan's *trailing* END_TURN is always legal and
    // would end the human's freshly-started turn — a one-keystroke turn steal.
    // If we no longer own the active turn, abandon whatever's left of the plan.
    if (planOwner !== null && deps.emitter.getState().currentPlayer !== planOwner) {
      pendingPlan = [];
      planOwner = null;
      return;
    }
    const t = now();
    if (t < nextActionAt) return;
    if (deps.animQueue.busy()) return;
    const action = pendingPlan.shift()!;
    const before = deps.emitter.getState();
    enqueueAnimationFor(before, action);
    deps.emitter.dispatch(action);
    nextActionAt = now() + pauseMs;
    if (deps.emitter.getState().winner !== null) {
      // Game ended mid-plan — abandon the rest.
      pendingPlan = [];
      planOwner = null;
    } else if (pendingPlan.length === 0) {
      planOwner = null;
    }
  }

  function enqueueAnimationFor(state: GameState, action: Action): void {
    if (action.type === 'MOVE') {
      const u = state.units[action.unitId];
      if (!u) return;
      deps.animQueue.enqueueMove(action.unitId, [u.pos, ...action.path]);
      return;
    }
    if (action.type === 'ATTACK') {
      enqueueAttackEffects(deps.animQueue, state, action.attackerId, action.targetId);
      return;
    }
    if (action.type === 'CAPTURE') {
      const u = state.units[action.unitId];
      if (!u) return;
      const progressGain = Math.floor(u.hp / 10);
      if (u.captureProgress + progressGain >= 20) {
        deps.animQueue.enqueueCaptureFlash(u.pos, u.owner);
      }
    }
  }

  return {
    setPlayerAI(player, choice): void {
      choices[player] = choice;
      log('ai', 'driver AI changed', { player, choice });
      // If we just switched the CURRENT player to non-human, the next tick
      // will plan. If we switched away from non-human mid-plan, abandon it.
      const state = deps.emitter.getState();
      if (state.currentPlayer === player && choice === 'human' && planOwner === player) {
        pendingPlan = [];
        planOwner = null;
      }
    },
    getPlayerAI(player): AIChoice {
      return choices[player];
    },
    inputLocked(state): boolean {
      return choices[state.currentPlayer] !== 'human';
    },
    tick(): void {
      planTurnIfNeeded();
      dispatchNext();
    },
    busy(): boolean {
      return pendingPlan.length > 0;
    },
  };
}
