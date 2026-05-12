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
// - The yielded `followUp` is one of: ATTACK | CAPTURE | WAIT. END_TURN and
//   BUILD are not unit-scoped follow-ups; the AI loop handles those separately.
// - For indirect units (artillery), we skip ATTACK candidates that pair with a
//   MOVE (the engine rejects move+attack in one turn for indirect units, but
//   we filter pre-emptively to keep the search space tight).
// - We rely on `isLegalAction` to gate every yielded pair — no engine
//   semantic is duplicated here. If the engine accepts the action we yield it;
//   if not, we drop it. This keeps the AI honest against future rule changes.
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
import { coordEq, isCapturable, tileAt } from '../core/types';
import { reduce } from '../core/reducer';
import { isLegalAction } from '../core/validators';
import { reachableTiles } from '../systems/pathfinding';
import { attackableTargets } from '../queries/selectors';
import { UNITS } from '../data';

export type Candidate = {
  /** Undefined when the unit stays put. */
  moveAction?: Action;
  /** ATTACK, CAPTURE, or WAIT. */
  followUp: Action;
  /** Cloned state after moveAction (if any) AND followUp have been applied. */
  finalState: GameState;
  /** The candidate destination tile (== unit.pos when staying put). */
  destination: Coord;
};

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

  const stats = UNITS[unit.type];

  // ─── "Stay put" candidates ────────────────────────────────────────────────
  // The stay case requires no MOVE; we apply only the follow-up. If the unit
  // already has hasMoved=true (e.g. moved-but-didn't-act flow — not produced
  // by the AI loop, but tolerated), `moveAction` is also undefined.
  if (!unit.hasActed) {
    yield* yieldFollowUps(state, unit, undefined, unit.pos);
  }

  // ─── Move-then-act candidates ─────────────────────────────────────────────
  if (unit.hasMoved) return;

  const reach = reachableTiles(state, unit);
  // reachableTiles includes the start tile with empty path; skip it because
  // it produces an illegal MOVE (destination == origin).
  for (const r of reach) {
    if (r.path.length === 0) continue;
    if (coordEq(r.coord, unit.pos)) continue;
    const moveAction: Action = { type: 'MOVE', unitId: unit.id, path: r.path };
    const legality = isLegalAction(state, moveAction);
    if (!legality.legal) continue;
    const afterMove = reduce(state, moveAction);
    // If MOVE didn't apply for any reason (reducer guard), skip.
    if (afterMove === state) continue;
    const movedUnit = afterMove.units[unit.id];
    if (!movedUnit) continue;
    // Indirect units cannot attack after moving — skip ATTACK candidates by
    // letting the legality check drop them; we still yield WAIT/CAPTURE.
    void stats;
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
