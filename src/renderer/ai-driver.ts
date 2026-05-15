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
// - If `state.winner !== null`, the driver does nothing.

import type { Action, GameState, PlayerId } from '../engine/core/types';
import { createRng } from '../engine/core/rng';
import type { Rng } from '../engine/core/rng';
import { previewAttack } from '../engine/systems/combat';
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
    if (choice === 'utility') return utilityAI({ name: 'utility' });
    // Otherwise it's a persona name — defer to the persona factory.
    return personaAI(choice);
  }

  function planTurnIfNeeded(): void {
    const state = deps.emitter.getState();
    if (state.winner !== null) return;
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
      deps.animQueue.enqueueAttack(action.attackerId, action.targetId);
      const attacker = state.units[action.attackerId];
      const target = state.units[action.targetId];
      if (!attacker || !target) return;
      const dmg = previewAttack(state, action.attackerId, action.targetId);
      if (target.hp - dmg.dealt <= 0) {
        deps.animQueue.enqueueDeath(target.id, target.pos);
      } else if (attacker.hp - dmg.counterReceived <= 0) {
        deps.animQueue.enqueueDeath(attacker.id, attacker.pos);
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
