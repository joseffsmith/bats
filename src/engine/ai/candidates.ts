// Candidate-action generation for one unit.
//
// Yields every legal `(MOVE destination, follow-up action)` pair the unit can
// execute this turn, plus the finalState after both actions have been applied.
// This is the search space the utility AI scores over and the random AI
// samples from.
//
// Contract:
// - The yielded `finalState` is a fresh clone — never the same reference as
//   the input state. Callers can re-`reduce()` against it without aliasing.
// - `moveAction` is undefined when the unit stays in place. The "stay" case is
//   always included so units that are already next to a juicy target don't
//   forfeit their turn.
// - The yielded `followUp` is one of: ATTACK | CAPTURE | WAIT | DIVE |
//   SURFACE | LOAD | UNLOAD. END_TURN and BUILD are not unit-scoped follow-ups;
//   the AI loop handles those separately.
// - For indirect units (artillery), we skip ATTACK candidates that pair with a
//   MOVE (the engine rejects move+attack in one turn for indirect units, but
//   we filter pre-emptively to keep the search space tight).
// - We rely on `isLegalAction` to gate every yielded pair — no engine
//   semantic is duplicated here. If the engine accepts the action we yield it;
//   if not, we drop it. This keeps the AI honest against future rule changes.
//
// Amphibious extensions:
// - LOAD: when a cargo-class unit (infantry, vehicle, air) has a friendly
//   transport in its reachable set (pathfinding includes friendly transports
//   as boarding terminals), we emit a single LOAD candidate instead of a MOVE
//   candidate for that tile (MOVE onto a friendly unit is illegal anyway).
// - UNLOAD: when a transport with cargo has not yet acted, we enumerate the
//   four neighbour tiles of its (possibly moved) position. Both "stay put +
//   UNLOAD" and "MOVE then UNLOAD" are produced.
// - DIVE / SURFACE: surfaced submarines yield a DIVE candidate, submerged subs
//   yield SURFACE. Both work as stay-put OR after-move follow-ups (the engine
//   doesn't gate either on hasMoved).
//
// Performance: a unit has up to ~50 reachable destinations on duel, each with
// up to ~4 follow-ups. For a player with 5 units that's <1k candidates per
// turn. Each candidate runs ~2 reducer dispatches (structuredClone each), so
// the AI turn budget is dominated by reducer work, not enumeration.

import type {
  Action,
  Coord,
  GameState,
  Unit,
} from '../core/types';
import { coordEq, inBounds, isCapturable, tileAt, unitAt } from '../core/types';
import { reduce } from '../core/reducer';
import { isLegalAction } from '../core/validators';
import { reachableTiles } from '../systems/pathfinding';
import { attackableTargets } from '../queries/selectors';
import { UNITS, TERRAIN } from '../data';

export type Candidate = {
  /** Undefined when the unit stays put. */
  moveAction?: Action;
  /** ATTACK, CAPTURE, WAIT, DIVE, SURFACE, LOAD, or UNLOAD. */
  followUp: Action;
  /** Cloned state after moveAction (if any) AND followUp have been applied. */
  finalState: GameState;
  /** The candidate destination tile (== unit.pos when staying put). */
  destination: Coord;
};

const NEIGHBOURS: ReadonlyArray<Coord> = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

/**
 * Generate all legal `(move, follow-up)` candidates for `unit` on `state`.
 * `state.currentPlayer` must equal `unit.owner` — otherwise the validator
 * rejects everything and the generator yields nothing.
 *
 * Order: we yield "stay in place" candidates first, then moves in destination
 * order. The utility AI picks the highest-scored candidate so order doesn't
 * affect correctness; the random AI relies on it being deterministic given
 * the input state (which is — `reachableTiles` is itself deterministic).
 */
export function* generateCandidates(
  state: GameState,
  unit: Unit,
): Generator<Candidate> {
  // Defensive: a unit that's already fully acted has no candidates.
  if (unit.hasMoved && unit.hasActed) return;

  // ─── "Stay put" candidates ────────────────────────────────────────────────
  // The stay case requires no MOVE; we apply only the follow-up. If the unit
  // already has hasMoved=true (e.g. moved-but-didn't-act flow — not produced
  // by the AI loop, but tolerated), `moveAction` is also undefined.
  if (!unit.hasActed) {
    yield* yieldFollowUps(state, unit, undefined, unit.pos);
  }

  // ─── Move-then-act candidates ─────────────────────────────────────────────
  if (unit.hasMoved) return;

  const stats = UNITS[unit.type];
  const cargoClass = stats.movementClass;
  const reach = reachableTiles(state, unit);
  // reachableTiles includes the start tile with empty path; skip it because
  // it produces an illegal MOVE (destination == origin).
  for (const r of reach) {
    if (r.path.length === 0) continue;
    if (coordEq(r.coord, unit.pos)) continue;

    // Is the destination occupied by a friendly transport that accepts us?
    // Then this candidate is a LOAD, not a MOVE — the underlying tile may be
    // impassable terrain (e.g. sea for a foot unit) but boarding is legal.
    const occ = unitAt(state, r.coord);
    if (occ && occ.id !== unit.id && occ.owner === unit.owner) {
      const tStats = UNITS[occ.type];
      const accepts =
        tStats.cargoCapacity > 0 &&
        tStats.cargoMovementClasses.includes(cargoClass) &&
        (occ.cargo?.length ?? 0) < tStats.cargoCapacity;
      if (accepts) {
        const load: Action = {
          type: 'LOAD',
          cargoId: unit.id,
          transportId: occ.id,
          path: r.path,
        };
        if (isLegalAction(state, load).legal) {
          const after = reduce(state, load);
          if (after !== state) {
            yield makeCandidate(undefined, load, after, r.coord);
          }
        }
      }
      // Either way, no MOVE onto this tile is legal.
      continue;
    }

    const moveAction: Action = { type: 'MOVE', unitId: unit.id, path: r.path };
    const legality = isLegalAction(state, moveAction);
    if (!legality.legal) continue;
    const afterMove = reduce(state, moveAction);
    // If MOVE didn't apply for any reason (reducer guard), skip.
    if (afterMove === state) continue;
    const movedUnit = afterMove.units[unit.id];
    if (!movedUnit) continue;
    yield* yieldFollowUps(afterMove, movedUnit, moveAction, r.coord);
  }
}

function makeCandidate(
  moveAction: Action | undefined,
  followUp: Action,
  finalState: GameState,
  destination: Coord,
): Candidate {
  const c: Candidate = { followUp, finalState, destination };
  if (moveAction) c.moveAction = moveAction;
  return c;
}

function* yieldFollowUps(
  state: GameState,
  unit: Unit,
  moveAction: Action | undefined,
  destination: Coord,
): Generator<Candidate> {
  // ATTACK — every in-range enemy.
  if (!unit.hasActed) {
    const targets = attackableTargets(state, unit);
    for (const t of targets) {
      const attack: Action = {
        type: 'ATTACK',
        attackerId: unit.id,
        targetId: t.id,
      };
      if (!isLegalAction(state, attack).legal) continue;
      const after = reduce(state, attack);
      if (after === state) continue;
      yield makeCandidate(moveAction, attack, after, destination);
    }
  }

  // CAPTURE — infantry on an unowned capturable tile.
  if (!unit.hasActed) {
    const stats = UNITS[unit.type];
    if (stats.canCapture) {
      const tile = tileAt(state.map, unit.pos);
      if (isCapturable(tile.terrain) && tile.owner !== unit.owner) {
        const cap: Action = { type: 'CAPTURE', unitId: unit.id };
        if (isLegalAction(state, cap).legal) {
          const after = reduce(state, cap);
          if (after !== state) {
            yield makeCandidate(moveAction, cap, after, destination);
          }
        }
      }
    }
  }

  // DIVE / SURFACE — submarine stealth toggle.
  if (!unit.hasActed && unit.type === 'submarine') {
    const toggle: Action = unit.submerged
      ? { type: 'SURFACE', unitId: unit.id }
      : { type: 'DIVE', unitId: unit.id };
    if (isLegalAction(state, toggle).legal) {
      const after = reduce(state, toggle);
      if (after !== state) {
        yield makeCandidate(moveAction, toggle, after, destination);
      }
    }
  }

  // UNLOAD — a transport with at least one loaded cargo unit. Yield one
  // candidate per (cargo × adjacent tile) combination; the scorer picks the
  // best drop position.
  if (!unit.hasActed) {
    const stats = UNITS[unit.type];
    if (stats.cargoCapacity > 0 && unit.cargo && unit.cargo.length > 0) {
      for (const cargoId of unit.cargo) {
        const cargo = state.units[cargoId];
        if (!cargo) continue;
        const cStats = UNITS[cargo.type];
        for (const n of NEIGHBOURS) {
          const dest: Coord = { x: unit.pos.x + n.x, y: unit.pos.y + n.y };
          if (!inBounds(state.map, dest)) continue;
          // Cheap pre-filter: passable terrain for the cargo's movement class.
          // The validator repeats this, but the early-out avoids the reducer
          // clone for obviously-bad drops (e.g. ground unit onto sea).
          const tile = tileAt(state.map, dest);
          const moveCost = TERRAIN[tile.terrain].moveCost[cStats.movementClass];
          if (!Number.isFinite(moveCost)) continue;
          if (unitAt(state, dest)) continue;
          const unload: Action = {
            type: 'UNLOAD',
            transportId: unit.id,
            cargoId,
            destination: dest,
          };
          if (!isLegalAction(state, unload).legal) continue;
          const after = reduce(state, unload);
          if (after === state) continue;
          yield makeCandidate(moveAction, unload, after, destination);
        }
      }
    }
  }

  // WAIT — always available unless already acted. We yield it last so the
  // utility AI prefers a real action when scores tie at 0.
  if (!unit.hasActed) {
    const wait: Action = { type: 'WAIT', unitId: unit.id };
    if (isLegalAction(state, wait).legal) {
      const after = reduce(state, wait);
      if (after !== state) {
        yield makeCandidate(moveAction, wait, after, destination);
      }
    }
  }
}
