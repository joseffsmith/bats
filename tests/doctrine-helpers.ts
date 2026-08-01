// Shared plumbing for the doctrine suite (tests/ai-doctrine.test.ts).
//
// Doctrine tests assert INTENT, not moves: "did the AI attack the capturer",
// "did the army close on the enemy HQ", "did the doomed tank run". They are
// micro-positions built with `makeState`, driven by `personaAI(...)`, and —
// where a single turn isn't enough to show intent — folded forward through
// the reducer with `playTurns`.
//
// Nothing here encodes an expectation. Assertions live in the test file; this
// module only builds positions, runs turns, and measures the result.

import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';
import { createRng } from '../src/engine/core/rng';
import { generateCandidates } from '../src/engine/ai/candidates';
import { coordEq, manhattan } from '../src/engine/core/types';
import type {
  Action,
  Coord,
  GameState,
  PlayerId,
  Unit,
  UnitId,
} from '../src/engine/core/types';
import type { InitialMapSpec } from '../src/engine/core/initial-state';
import type { AI } from '../src/engine/ai/types';

// ─────────────────────────── Position building ───────────────────────────────

export const PERSONA_LIST: ReadonlyArray<string> = [
  'aggressor',
  'turtle',
  'economist',
  'balanced',
];

export type ArenaSpec = {
  /** Defaults to 12. */
  width?: number;
  /** Defaults to 7. */
  height?: number;
  /** Defaults to 'plain'. */
  defaultTerrain?: InitialMapSpec['defaultTerrain'];
  /** Defaults to the left-middle tile. */
  hq0?: Coord;
  /** Defaults to the right-middle tile. */
  hq1?: Coord;
  tiles?: InitialMapSpec['tiles'];
  units?: InitialMapSpec['units'];
  /** Defaults to 0 for both players (no BUILD noise unless a test wants it). */
  funds?: InitialMapSpec['funds'];
  /** Player to act. Defaults to 0. */
  currentPlayer?: PlayerId;
  /**
   * captureProgress overrides keyed by generated unit id — units are numbered
   * `u1`, `u2`, … in `units` order (see createInitialState).
   */
  capturing?: Record<UnitId, number>;
};

/**
 * `makeState` with the boilerplate every doctrine position repeats: a plain
 * rectangle, two facing HQs, zero funds, and an explicit acting player.
 */
export function arena(spec: ArenaSpec): GameState {
  const width = spec.width ?? 12;
  const height = spec.height ?? 7;
  const midY = Math.floor(height / 2);
  const state = makeState({
    width,
    height,
    defaultTerrain: spec.defaultTerrain ?? 'plain',
    hqs: [
      { owner: 0, pos: spec.hq0 ?? { x: 0, y: midY } },
      { owner: 1, pos: spec.hq1 ?? { x: width - 1, y: midY } },
    ],
    // Spread-if-present: `exactOptionalPropertyTypes` forbids passing an
    // explicit `undefined` for an optional field.
    ...(spec.tiles ? { tiles: spec.tiles } : {}),
    ...(spec.units ? { units: spec.units } : {}),
    funds: spec.funds ?? { 0: 0, 1: 0 },
  });
  for (const [id, progress] of Object.entries(spec.capturing ?? {})) {
    const u = state.units[id];
    if (!u) throw new Error(`arena: no unit "${id}" to set captureProgress on`);
    u.captureProgress = progress;
  }
  state.currentPlayer = spec.currentPlayer ?? 0;
  return state;
}

// ─────────────────────────── Multi-turn driving ──────────────────────────────

/** One AI turn: the state it started from, what it decided, where it ended. */
export type TurnLog = {
  player: PlayerId;
  /** 0-based index among THIS player's turns in the run. */
  index: number;
  /** State at the start of the turn. */
  before: GameState;
  /** Actions the AI returned, including its trailing END_TURN. */
  actions: Action[];
  /**
   * `states[i]` is the state the reducer saw before `actions[i]`; the last
   * entry is the post-END_TURN state. Lets a test ask "where was the unit
   * when it issued that CAPTURE?" without re-simulating.
   */
  states: GameState[];
  /** State after every action has been folded (== last entry of `states`). */
  after: GameState;
};

export type PlayResult = {
  /** Final folded state. */
  state: GameState;
  /** Every half-turn played, in order. */
  turns: TurnLog[];
};

/**
 * Alternate `ai.takeTurn` between the two players, folding each returned
 * action through `reduce` (the replay.test.ts fold, one turn at a time).
 *
 * `ownTurns` counts the turns of whoever is `state.currentPlayer` on entry —
 * the side under test. So `playTurns(s, ais, 2)` = driver, opponent, driver,
 * ending just after the driver's second END_TURN. Stops early once a winner
 * is set.
 *
 * The utility AI is rng-independent today, but we still thread a fresh
 * `createRng` per half-turn so the runs stay reproducible if that changes.
 */
export function playTurns(
  state: GameState,
  ais: Record<PlayerId, AI>,
  ownTurns: number,
  opts: { seed?: number } = {},
): PlayResult {
  const driver = state.currentPlayer;
  const seed = opts.seed ?? 1;
  const counts: Record<PlayerId, number> = { 0: 0, 1: 0 };
  const turns: TurnLog[] = [];
  let cur = state;
  let half = 0;

  while (counts[driver] < ownTurns && cur.winner === null) {
    const player = cur.currentPlayer;
    const ai = ais[player];
    if (!ai) throw new Error(`playTurns: no AI for player ${player}`);
    const before = cur;
    const actions = ai.takeTurn({ state: cur, player, rng: createRng(seed + half) });
    const states: GameState[] = [cur];
    for (const a of actions) {
      cur = reduce(cur, a);
      states.push(cur);
    }
    // Defensive: an AI that forgot to END_TURN would deadlock the loop.
    if (cur.currentPlayer === player && cur.winner === null) {
      cur = reduce(cur, { type: 'END_TURN' });
      states.push(cur);
    }
    turns.push({ player, index: counts[player], before, actions, states, after: cur });
    counts[player] += 1;
    half += 1;
  }

  return { state: cur, turns };
}

/** An AI that does nothing at all — the passive sparring partner. */
export function passiveAI(name = 'passive'): AI {
  return {
    name,
    takeTurn: () => [{ type: 'END_TURN' }],
  };
}

// ─────────────────────────── Reading a run back ──────────────────────────────

export function turnsOf(result: PlayResult, player: PlayerId): TurnLog[] {
  return result.turns.filter((t) => t.player === player);
}

/** Every action the player issued across the run, flattened, in order. */
export function actionsOf(result: PlayResult, player: PlayerId): Action[] {
  return turnsOf(result, player).flatMap((t) => t.actions);
}

/**
 * Positions of `player`'s units at the START of each of its turns, plus one
 * final snapshot from the end of the run. Index i = turn i's opening layout.
 */
export function positionTrack(
  result: PlayResult,
  player: PlayerId,
): Array<Map<UnitId, Coord>> {
  const mine = turnsOf(result, player);
  const track = mine.map((t) => unitPositions(t.before, player));
  const last = mine[mine.length - 1];
  if (last) track.push(unitPositions(last.after, player));
  return track;
}

export function unitPositions(state: GameState, player: PlayerId): Map<UnitId, Coord> {
  const out = new Map<UnitId, Coord>();
  for (const u of Object.values(state.units)) {
    if (u.owner === player) out.set(u.id, { x: u.pos.x, y: u.pos.y });
  }
  return out;
}

export function ownUnits(state: GameState, player: PlayerId): Unit[] {
  return Object.values(state.units)
    .filter((u) => u.owner === player)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Ids that appear in every snapshot of `track` — the units that survived the
 * whole run, i.e. the only ones whose movement history is comparable.
 */
export function persistentIds(track: Array<Map<UnitId, Coord>>): UnitId[] {
  const first = track[0];
  if (!first) return [];
  return [...first.keys()].filter((id) => track.every((snap) => snap.has(id)));
}

/**
 * True when the unit's position history contains an A→B→A→B alternation:
 * two distinct tiles swapped back and forth across four consecutive turns.
 */
export function oscillates(path: ReadonlyArray<Coord>): boolean {
  for (let i = 0; i + 3 < path.length; i++) {
    const [a, b, c, d] = [path[i]!, path[i + 1]!, path[i + 2]!, path[i + 3]!];
    if (coordEq(a, b)) continue;
    if (coordEq(a, c) && coordEq(b, d)) return true;
  }
  return false;
}

/** Position history of one unit across a `positionTrack`. */
export function pathOf(track: Array<Map<UnitId, Coord>>, id: UnitId): Coord[] {
  const out: Coord[] = [];
  for (const snap of track) {
    const p = snap.get(id);
    if (p) out.push(p);
  }
  return out;
}

/** True if every snapshot puts the unit on the tile it started on. */
export function neverLeftStart(path: ReadonlyArray<Coord>): boolean {
  const start = path[0];
  if (!start) return false;
  return path.every((p) => coordEq(p, start));
}

/**
 * Does the unit have somewhere legal and productive to go? True when at least
 * one generated candidate lands it on a different tile — i.e. parking is a
 * choice, not a constraint.
 */
export function hasMoveCandidates(state: GameState, unit: Unit): boolean {
  for (const c of generateCandidates(state, unit)) {
    if (!coordEq(c.destination, unit.pos)) return true;
  }
  return false;
}

// ─────────────────────────── Geometry / action filters ───────────────────────

export function hqOf(state: GameState, player: PlayerId): Coord {
  return state.players[player].hq;
}

export function distToHq(pos: Coord, state: GameState, player: PlayerId): number {
  return manhattan(pos, hqOf(state, player));
}

/** Mean manhattan distance from `pos` to every living unit of `player`. */
export function distToMass(pos: Coord, state: GameState, player: PlayerId): number {
  const enemies = ownUnits(state, player);
  if (enemies.length === 0) return 0;
  const total = enemies.reduce((acc, u) => acc + manhattan(pos, u.pos), 0);
  return total / enemies.length;
}

export function attacksIn(actions: ReadonlyArray<Action>): Array<Extract<Action, { type: 'ATTACK' }>> {
  return actions.filter((a): a is Extract<Action, { type: 'ATTACK' }> => a.type === 'ATTACK');
}

export function movesOf(
  actions: ReadonlyArray<Action>,
  unitId: UnitId,
): Array<Extract<Action, { type: 'MOVE' }>> {
  return actions.filter(
    (a): a is Extract<Action, { type: 'MOVE' }> => a.type === 'MOVE' && a.unitId === unitId,
  );
}

/** Final destination of the unit's last MOVE this turn, or null if it never moved. */
export function finalDestination(
  actions: ReadonlyArray<Action>,
  unitId: UnitId,
): Coord | null {
  const moves = movesOf(actions, unitId);
  const last = moves[moves.length - 1];
  if (!last) return null;
  return last.path[last.path.length - 1] ?? null;
}

/**
 * Every CAPTURE issued during `turn` by a unit that was standing on `coord`
 * at the moment the action was dispatched.
 */
export function capturesAt(turn: TurnLog, coord: Coord): Array<Extract<Action, { type: 'CAPTURE' }>> {
  const out: Array<Extract<Action, { type: 'CAPTURE' }>> = [];
  turn.actions.forEach((a, i) => {
    if (a.type !== 'CAPTURE') return;
    const s = turn.states[i];
    const u = s?.units[a.unitId];
    if (u && coordEq(u.pos, coord)) out.push(a);
  });
  return out;
}

export { manhattan };
