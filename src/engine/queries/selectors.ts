// Derived-data selectors. Pure functions over GameState — never mutate.

import type { Coord, GameState, Unit, UnitId } from '../core/types';
import { inBounds, manhattan, unitAt } from '../core/types';
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
 */
export function attackableTargets(state: GameState, unit: Unit): Unit[] {
  const stats = UNITS[unit.type];
  if (stats.maxRange <= 0) return []; // transports / non-combat
  const out: Unit[] = [];
  for (const other of Object.values(state.units)) {
    if (other.owner === unit.owner) continue;
    if (other.loadedIn !== undefined) continue;
    const d = manhattan(unit.pos, other.pos);
    if (d >= stats.minRange && d <= stats.maxRange) out.push(other);
  }
  return out;
}

/** Convenience: lookup by id, returning undefined if missing. */
export function getUnit(state: GameState, id: UnitId): Unit | undefined {
  return state.units[id];
}

/** Convenience: who (if anyone) stands on this tile. */
export function occupantAt(state: GameState, c: Coord): Unit | undefined {
  return unitAt(state, c);
}
