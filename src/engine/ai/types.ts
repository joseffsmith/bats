// AI interface. Pure: an AI is a function from (state, player, rng) to a
// full action sequence for one turn, terminating with END_TURN. Implementations
// MUST NOT mutate the input state — they return fresh actions only.
//
// We deliberately model an AI as a *whole-turn* planner rather than a
// step-at-a-time picker. That makes the CLI/runner loop trivial (just splat
// the actions into the reducer one at a time) and lets the AI internally
// simulate its own moves on a cloned state without coordination with the
// outside world.
//
// `name` is shown in logs and the tournament summary table.
//
// `AIFactory` lets us pass tunable opts (e.g. utility weights, an alternative
// AI persona id for later phases) without growing a parallel constructor.

import type { Action, GameState, PlayerId } from '../core/types';
import type { Rng } from '../core/rng';

export type AIContext = {
  state: GameState;
  player: PlayerId;
  rng: Rng;
};

export interface AI {
  readonly name: string;
  /**
   * Returns the FULL action sequence for one turn, terminating with END_TURN.
   * Implementations MUST NOT mutate the input state — return fresh actions.
   */
  takeTurn(ctx: AIContext): Action[];
}

export type AIFactory = (opts?: Record<string, unknown>) => AI;
