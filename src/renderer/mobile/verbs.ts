// Verb inference for the mobile input grammar (select → stage → commit).
//
// Pure functions over GameState — no DOM, no engine mutation, no dispatch.
// The mobile branch of `input.ts` asks three questions here:
//
//   inferVerb()          "the player tapped THIS tile with THAT unit selected —
//                         what did they mean?"  → move / attack / capture / null
//   bestAttackPosition() "…and if they meant attack, where do we shoot from?"
//   needsOrders()        "after the MOVE lands, is the follow-up genuinely
//                         ambiguous?" → open the orders menu instead of fusing
//
// Everything here is deterministic: same state + same tap ⇒ same verb, same
// firing tile. That is what lets the grammar stage an action, show it, and
// commit it on a second tap without the player ever seeing it move under them.

import type { Coord, GameState, Unit } from '../../engine/core/types';
import {
  coordEq,
  isCapturable,
  manhattan,
  tileAt,
  unitAt,
} from '../../engine/core/types';
import { TERRAIN, UNITS } from '../../engine/data';
import { attackableTargets } from '../../engine/queries/selectors';
import type { ReachableTile } from '../../engine/systems/pathfinding';

/** The action a tap stages. `null` (no verb) deselects. */
export type Verb = 'move' | 'attack' | 'capture';

/**
 * What the player meant by tapping `tile` while `unit` is selected.
 *
 * Precedence, highest first:
 *   1. enemy on the tile        → 'attack'  (iff a legal firing position exists)
 *   2. friendly on the tile     → null      (caller switches selection / stages a LOAD)
 *   3. reachable capturable tile not owned by us, and the unit can capture
 *                               → 'capture' (includes the tile the unit stands on)
 *   4. reachable tile with a non-empty path
 *                               → 'move'
 *   5. anything else            → null
 *
 * Note (3) deliberately outranks (4): tapping an infantry onto a neutral city
 * means "take it", never "stand on it". The plain-move path can still reach a
 * property with a unit that cannot capture.
 */
export function inferVerb(
  state: GameState,
  unit: Unit,
  reachable: ReachableTile[],
  tile: Coord,
): Verb | null {
  if (unit.hasActed) return null;

  const occupant = unitAt(state, tile);
  if (occupant && occupant.owner !== unit.owner) {
    return bestAttackPosition(state, unit, reachable, occupant) ? 'attack' : null;
  }
  // A friendly unit is not a verb: the caller either switches the selection or
  // stages a LOAD (both need the occupant, which this module doesn't return).
  if (occupant && occupant.id !== unit.id) return null;

  const reach = reachable.find((r) => coordEq(r.coord, tile));
  if (!reach) return null;

  const stats = UNITS[unit.type];
  if (stats.canCapture) {
    const t = tileAt(state.map, tile);
    if (isCapturable(t.terrain) && t.owner !== unit.owner) return 'capture';
  }
  if (reach.path.length > 0) return 'move';
  // The unit's own tile with nothing to capture: no verb. The caller reads this
  // as "open the orders menu" rather than as a deselect.
  return null;
}

/**
 * Where `unit` should stand to attack `target`, or null if it cannot.
 *
 * Deterministic ordering over the candidate firing tiles:
 *   1. highest terrain defense stars  (survive the counter)
 *   2. lowest path cost               (don't wander for no reason)
 *   3. lowest y, then lowest x        (stable, map-order tiebreak)
 *
 * Indirect units are a special case: the engine forbids move-then-fire
 * (`validators.checkAttack`), so their only legal firing position is the tile
 * they already occupy — and only while they haven't moved this turn. They
 * therefore stage attack-in-place with an empty path, and only when the target
 * is ALREADY in range.
 */
export function bestAttackPosition(
  state: GameState,
  unit: Unit,
  reachable: ReachableTile[],
  target: Unit,
): ReachableTile | null {
  if (unit.hasActed) return null;
  if (target.owner === unit.owner) return null;
  if (target.loadedIn !== undefined) return null; // cargo isn't on the board
  if (target.phantom === true) return null; // can't shoot a fog memory
  const stats = UNITS[unit.type];
  if (stats.maxRange <= 0) return null; // transports & friends

  // Submerged-sub stealth mirrors `selectors.attackableTargets`: only cruisers
  // and submarines can engage a dived submarine.
  if (
    target.type === 'submarine' &&
    target.submerged === true &&
    unit.type !== 'cruiser' &&
    unit.type !== 'submarine'
  ) {
    return null;
  }

  const inRange = (from: Coord): boolean => {
    const d = manhattan(from, target.pos);
    return d >= stats.minRange && d <= stats.maxRange;
  };

  if (stats.indirect) {
    if (unit.hasMoved) return null;
    if (!inRange(unit.pos)) return null;
    return { coord: { x: unit.pos.x, y: unit.pos.y }, cost: 0, path: [] };
  }

  let best: ReachableTile | null = null;
  for (const r of reachable) {
    if (!inRange(r.coord)) continue;
    // Guard against a reachable entry that isn't a legal stopping tile: the
    // start tile is the only zero-length path, and an occupied tile (a friendly
    // transport, included by `reachableTiles` as a LOAD destination) is not a
    // place we can stand and shoot from.
    if (r.path.length === 0 && !coordEq(r.coord, unit.pos)) continue;
    const occ = unitAt(state, r.coord);
    if (occ && occ.id !== unit.id) continue;
    if (best === null || compareFiringTiles(state, r, best) < 0) best = r;
  }
  return best;
}

/** Sort comparator behind `bestAttackPosition`'s tiebreak chain. */
function compareFiringTiles(
  state: GameState,
  a: ReachableTile,
  b: ReachableTile,
): number {
  const sa = TERRAIN[tileAt(state.map, a.coord).terrain].defenseStars;
  const sb = TERRAIN[tileAt(state.map, b.coord).terrain].defenseStars;
  if (sa !== sb) return sb - sa; // more stars first
  if (a.cost !== b.cost) return a.cost - b.cost;
  if (a.coord.y !== b.coord.y) return a.coord.y - b.coord.y;
  return a.coord.x - b.coord.x;
}

/**
 * True when a unit that has just finished its MOVE has a genuinely ambiguous
 * follow-up and the player must be asked. That means BOTH of the two
 * board-changing verbs are on the table at the destination:
 *
 *   - it can capture where it stands (canCapture, capturable tile, not ours), and
 *   - it can attack something from where it stands.
 *
 * Anything less is not ambiguous — a lone capture or a lone attack is exactly
 * what the staged verb already said. Note this only gates the ATTACK/CAPTURE
 * commits: a BARE staged move asks a wider question in `commitStagedMove`
 * (any enabled order beyond Wait opens the menu), because a plain move never
 * named a follow-up verb at all — an implicit WAIT there was throwing away
 * lone attacks, unloads and dives.
 */
export function needsOrders(state: GameState, unit: Unit): boolean {
  if (unit.hasActed) return false;
  const stats = UNITS[unit.type];
  const tile = tileAt(state.map, unit.pos);
  const canCapture =
    stats.canCapture && isCapturable(tile.terrain) && tile.owner !== unit.owner;
  if (!canCapture) return false;
  const canAttack =
    stats.maxRange > 0 &&
    (!stats.indirect || !unit.hasMoved) &&
    attackableTargets(state, unit).length > 0;
  return canAttack;
}
