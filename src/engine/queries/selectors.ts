// Derived-data selectors. Pure functions over GameState — never mutate.

import type { Coord, GameState, PlayerId, Unit, UnitId } from '../core/types';
import { coordEq, inBounds, manhattan, unitAt } from '../core/types';
import { UNITS } from '../data';
import { reachableTiles } from '../systems/pathfinding';
import type { ReachableTile } from '../systems/pathfinding';

export { reachableTiles };
export type { ReachableTile };

/**
 * All tiles within `[minRange, maxRange]` Manhattan distance of `from`,
 * clipped to map bounds. Used both for direct-melee and indirect-fire ranges.
 */
export function tilesInRange(
  state: GameState,
  from: Coord,
  minRange: number,
  maxRange: number,
): Coord[] {
  const out: Coord[] = [];
  for (let dy = -maxRange; dy <= maxRange; dy++) {
    for (let dx = -maxRange; dx <= maxRange; dx++) {
      const d = Math.abs(dx) + Math.abs(dy);
      if (d < minRange || d > maxRange) continue;
      const c = { x: from.x + dx, y: from.y + dy };
      if (!inBounds(state.map, c)) continue;
      out.push(c);
    }
  }
  return out;
}

/**
 * Enemy units that `unit` can attack from its current position. For direct
 * units this is adjacent enemies. For indirect (artillery) this is enemies at
 * Manhattan distance ∈ [2, 3].
 *
 * Loaded units (cargo aboard a transport) are NOT targetable: combat sees only
 * free-standing units.
 *
 * Stealth: a submerged enemy submarine is targetable only by the attacker's
 * own cruisers and submarines — every other unit type filters it out at any
 * range. (Even an in-range battleship treats a dived sub as invisible, since
 * it cannot detect what it cannot see; the submarine-vs-battleship damage
 * cell only fires when the sub is on the surface.)
 */
export function attackableTargets(state: GameState, unit: Unit): Unit[] {
  const stats = UNITS[unit.type];
  if (stats.maxRange <= 0) return []; // transports / non-combat
  const out: Unit[] = [];
  for (const other of Object.values(state.units)) {
    if (other.owner === unit.owner) continue;
    if (other.loadedIn !== undefined) continue;
    const d = manhattan(unit.pos, other.pos);
    if (d < stats.minRange || d > stats.maxRange) continue;
    // Submerged-sub stealth: only cruisers + submarines can target a dived
    // enemy sub. (Cruiser is the canonical counter; subs can spot each
    // other underwater.)
    if (
      other.type === 'submarine' &&
      other.submerged === true &&
      unit.type !== 'cruiser' &&
      unit.type !== 'submarine'
    ) {
      continue;
    }
    out.push(other);
  }
  return out;
}

/**
 * Whether the submerged enemy submarine `unit` is visible to player
 * `observer`. A submerged sub is hidden from `observer` unless `observer`
 * owns a cruiser or submarine (in any state) within Manhattan distance 1 of
 * the sub. Owns-own-units is implicit: the sub's own player always sees it.
 * Non-submerged subs are always visible (return true). Non-sub units are
 * always visible.
 */
export function isVisibleTo(
  state: GameState,
  unit: Unit,
  observer: PlayerId,
): boolean {
  if (unit.owner === observer) return true;
  if (unit.type !== 'submarine' || unit.submerged !== true) return true;
  // Look for a friendly (to the observer) cruiser or submarine within
  // Manhattan distance 1 of the sub.
  for (const other of Object.values(state.units)) {
    if (other.owner !== observer) continue;
    if (other.loadedIn !== undefined) continue;
    if (other.type !== 'cruiser' && other.type !== 'submarine') continue;
    if (manhattan(other.pos, unit.pos) <= 1) return true;
  }
  return false;
}

/**
 * Viewer-aware lookup: which unit (if any) is visible to `viewer` at
 * coordinate `c`. A submerged enemy submarine on `c` is hidden unless the
 * viewer has a spotter (cruiser/submarine) within Manhattan distance 1.
 * Renderer + input controller consume this; the reducer still operates on
 * the unmasked truth via `unitAt`.
 */
export function visibleUnitAt(
  state: GameState,
  c: Coord,
  viewer: PlayerId,
): Unit | undefined {
  for (const u of Object.values(state.units)) {
    if (u.loadedIn !== undefined) continue;
    if (!coordEq(u.pos, c)) continue;
    if (!isVisibleTo(state, u, viewer)) continue;
    return u;
  }
  return undefined;
}

/** Convenience: lookup by id, returning undefined if missing. */
export function getUnit(state: GameState, id: UnitId): Unit | undefined {
  return state.units[id];
}

/** Convenience: who (if anyone) stands on this tile. */
export function occupantAt(state: GameState, c: Coord): Unit | undefined {
  return unitAt(state, c);
}
