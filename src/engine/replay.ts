// Replay engine.
//
// The reducer architecture makes replays trivial: given an initial state and
// the ordered list of actions taken during a match, we just fold the reducer
// to reach the final state. As a bonus we yield each intermediate state so a
// viewer can step through the match action-by-action.
//
// Two surface APIs:
//   - replay(initial, actions): produces the final GameState (and intermediate
//     states via `states`).
//   - stepReplay(initial, actions, n): produces the state after `n` actions.
//
// We deliberately log under the new `replay` category so a CLI or browser
// stepper can opt into per-step traces without flooding match logs.

import type { Action, GameState } from './core/types';
import { reduce } from './core/reducer';
import { log } from './core/logger';

export type ReplayResult = {
  /** State after every action, indexed by action index + 1. states[0] is the initial state. */
  states: GameState[];
  finalState: GameState;
  /** Action indices that the reducer treated as no-ops (next === current). */
  skipped: number[];
};

export function replay(initial: GameState, actions: readonly Action[]): ReplayResult {
  const states: GameState[] = [initial];
  const skipped: number[] = [];
  let state = initial;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    const next = reduce(state, a);
    if (next === state) {
      skipped.push(i);
      log('replay', 'no-op action', { index: i, type: a.type });
    } else {
      log('replay', 'step', {
        index: i,
        type: a.type,
        turn: next.turn,
        player: next.currentPlayer,
      });
    }
    state = next;
    states.push(state);
  }
  return { states, finalState: state, skipped };
}

/** Walk forward `n` actions from initial. Negative `n` is treated as 0. */
export function stepReplay(
  initial: GameState,
  actions: readonly Action[],
  n: number,
): GameState {
  const target = Math.max(0, Math.min(actions.length, n));
  let state = initial;
  for (let i = 0; i < target; i++) {
    const a = actions[i]!;
    state = reduce(state, a);
  }
  return state;
}

// ─────────────────────────── JSONL log parsing ───────────────────────────────

/**
 * Header line written at the top of `runMatch`'s JSONL log. Records enough
 * metadata for `replay-cli` to rebuild the initial state.
 */
export type LogHeader = {
  type: 'header';
  map: string;
  seed: number;
  maxTurns?: number;
  p0?: string;
  p1?: string;
  startedAt?: string;
};

export type LogAction = {
  type: 'action';
  turn: number;
  player: 0 | 1;
  action: Action;
};

export type LogSummary = {
  type: 'summary';
  turns: number;
  winner: 0 | 1 | null;
  unitCount?: Record<string, number>;
  funds?: Record<string, number>;
  elapsedMs?: number;
};

export type LogLine = LogHeader | LogAction | LogSummary;

export type ParsedLog = {
  header: LogHeader;
  actions: Action[];
  summary?: LogSummary;
};

/**
 * Parse a JSONL log produced by `runMatch`. The first non-empty line must be
 * a header; subsequent lines are actions or a final summary.
 */
export function parseLog(text: string): ParsedLog {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error('replay parseLog: empty log');
  const headerLine = JSON.parse(lines[0]!) as LogLine;
  if (headerLine.type !== 'header') {
    throw new Error('replay parseLog: first line is not a header');
  }
  const actions: Action[] = [];
  let summary: LogSummary | undefined;
  for (let i = 1; i < lines.length; i++) {
    const obj = JSON.parse(lines[i]!) as LogLine;
    if (obj.type === 'action') actions.push(obj.action);
    else if (obj.type === 'summary') summary = obj;
    else if (obj.type === 'header') {
      throw new Error(`replay parseLog: unexpected second header at line ${i + 1}`);
    }
  }
  return summary ? { header: headerLine, actions, summary } : { header: headerLine, actions };
}
