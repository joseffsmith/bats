// Dijkstra over the map graph, weighted by movement-class × terrain cost.
//
// Rules:
// - Edge weight = TERRAIN[tile].moveCost[unit.movementClass]. Infinity =
//   impassable.
// - Cannot pass through enemy units. Can pass through own units, but cannot
//   stop on a tile occupied by another unit.
// - Movement budget = UNITS[unit.type].move. Reachable tile = total cost ≤
//   move budget.

import type { Coord, GameState, Unit } from '../core/types';
import { coordEq, coordKey, inBounds, unitAt } from '../core/types';
import { TERRAIN, UNITS } from '../data';

export type ReachableTile = {
  coord: Coord;
  cost: number;
  /** Path excludes the start tile, includes the destination tile. */
  path: Coord[];
};

const NEIGHBOURS: ReadonlyArray<Coord> = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

/** Step cost from current coord onto `to` for the given unit. Infinity = impassable. */
export function stepCost(state: GameState, unit: Unit, to: Coord): number {
  if (!inBounds(state.map, to)) return Infinity;
  const row = state.map[to.y];
  if (!row) return Infinity;
  const tile = row[to.x];
  if (!tile) return Infinity;
  const cls = UNITS[unit.type].movementClass;
  return TERRAIN[tile.terrain].moveCost[cls];
}

/**
 * Compute every tile reachable by `unit` from its current position, within
 * its movement budget. The starting tile is included with cost 0 and an
 * empty path.
 *
 * Loading exception: a friendly transport-with-capacity that accepts this
 * unit's movement class is INCLUDED in the reachable set as a valid LOAD
 * destination, even though it's an occupied tile. The caller (renderer /
 * AI) dispatches LOAD instead of MOVE when the chosen destination is a
 * transport.
 */
export function reachableTiles(state: GameState, unit: Unit): ReachableTile[] {
  const budget = UNITS[unit.type].move;
  const unitMovementClass = UNITS[unit.type].movementClass;
  // Dijkstra
  const dist = new Map<string, number>();
  const prev = new Map<string, Coord | null>();
  const start = unit.pos;
  dist.set(coordKey(start), 0);
  prev.set(coordKey(start), null);

  // Simple priority queue via repeated linear scan — n is small.
  const open = new Set<string>([coordKey(start)]);
  const openCoord = new Map<string, Coord>([[coordKey(start), start]]);

  while (open.size > 0) {
    // Find min-cost node in open.
    let bestKey: string | null = null;
    let bestCost = Infinity;
    for (const k of open) {
      const c = dist.get(k);
      if (c !== undefined && c < bestCost) {
        bestCost = c;
        bestKey = k;
      }
    }
    if (bestKey === null) break;
    open.delete(bestKey);
    const here = openCoord.get(bestKey);
    openCoord.delete(bestKey);
    if (!here) continue;

    for (const d of NEIGHBOURS) {
      const next: Coord = { x: here.x + d.x, y: here.y + d.y };
      if (!inBounds(state.map, next)) continue;
      const occupant = unitAt(state, next);
      // Cannot pass through enemies (a moving unit treats enemy tiles as
      // impassable). Can pass through own units, but cannot stop on them.
      if (occupant && occupant.owner !== unit.owner) continue;
      // Boarding exception: a friendly transport-with-capacity is a valid
      // terminal node even if the underlying terrain is impassable for this
      // unit (e.g. a foot unit boarding a transport parked on sea). We charge
      // a flat boarding cost of 1 and don't expand neighbours from this tile.
      const isBoardingTarget =
        !!occupant &&
        occupant.owner === unit.owner &&
        occupant.id !== unit.id &&
        canLoadInto(occupant, unitMovementClass);
      let cost: number;
      if (isBoardingTarget) {
        cost = 1;
      } else {
        cost = stepCost(state, unit, next);
        if (!isFinite(cost)) continue;
      }
      const total = bestCost + cost;
      if (total > budget) continue;
      const nk = coordKey(next);
      const existing = dist.get(nk);
      if (existing === undefined || total < existing) {
        dist.set(nk, total);
        prev.set(nk, here);
        // Don't expand neighbours of a boarding target (it's a terminal node).
        if (!isBoardingTarget) {
          open.add(nk);
          openCoord.set(nk, next);
        }
      }
    }
  }

  // Build paths. Skip tiles occupied by another unit (cannot stop there) —
  // except the start tile, which we always include with cost 0.
  // EXCEPTION: a friendly transport with available capacity that accepts our
  // movement class is included as a LOAD destination.
  const out: ReachableTile[] = [];
  for (const [k, cost] of dist) {
    const [xs, ys] = k.split(',');
    const coord: Coord = { x: Number(xs), y: Number(ys) };
    if (!coordEq(coord, start)) {
      const occ = unitAt(state, coord);
      if (occ && occ.id !== unit.id) {
        // Allow stopping on a friendly transport that can accept us.
        if (occ.owner === unit.owner && canLoadInto(occ, unitMovementClass)) {
          // fall through and emit as reachable
        } else {
          continue;
        }
      }
    }
    // Reconstruct.
    const path: Coord[] = [];
    let cur: Coord | null = coord;
    while (cur && !coordEq(cur, start)) {
      path.unshift(cur);
      cur = prev.get(coordKey(cur)) ?? null;
    }
    out.push({ coord, cost, path });
  }
  return out;
}

/** Is `transport` a transport with free capacity accepting `cargoClass`? */
function canLoadInto(transport: Unit, cargoClass: string): boolean {
  const stats = UNITS[transport.type];
  if (stats.cargoCapacity <= 0) return false;
  if (!stats.cargoMovementClasses.includes(cargoClass as never)) return false;
  const carried = transport.cargo?.length ?? 0;
  return carried < stats.cargoCapacity;
}

/**
 * Path validator used by LOAD. Same rules as `validatePath` but the
 * destination is REQUIRED to be the named transport's tile (otherwise we'd
 * be MOVE-ing onto a friendly unit, which is illegal). Intermediate friendly
 * passthrough still allowed; enemy crossing still illegal.
 */
export function validateLoadPath(
  state: GameState,
  unit: Unit,
  path: Coord[],
  transportId: string,
): { ok: true; cost: number } | { ok: false; reason: string } {
  if (path.length === 0) return { ok: false, reason: 'empty path' };
  const budget = UNITS[unit.type].move;
  let cost = 0;
  let prev = unit.pos;
  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    if (!step) return { ok: false, reason: 'undefined path step' };
    const dx = Math.abs(step.x - prev.x);
    const dy = Math.abs(step.y - prev.y);
    if (dx + dy !== 1) {
      return { ok: false, reason: `non-adjacent step at index ${i}` };
    }
    const isLast = i === path.length - 1;
    // Boarding exception: the final step onto the transport's tile is the
    // load action, not a movement onto the underlying terrain. A foot unit
    // boarding a transport parked on sea would otherwise fail because sea is
    // impassable for foot. We charge a flat cost of 1 for the boarding step
    // so the cargo can't load from infinitely far.
    if (isLast) {
      const occ = unitAt(state, step);
      if (occ && occ.id === transportId) {
        cost += 1;
        if (cost > budget) {
          return { ok: false, reason: `exceeds move budget (${cost} > ${budget})` };
        }
        prev = step;
        continue;
      }
      // Otherwise the final tile must be the named transport — anything else
      // is illegal.
      return { ok: false, reason: 'destination not the LOAD target transport' };
    }
    const c = stepCost(state, unit, step);
    if (!isFinite(c)) {
      return { ok: false, reason: `impassable tile at index ${i}` };
    }
    cost += c;
    if (cost > budget) {
      return { ok: false, reason: `exceeds move budget (${cost} > ${budget})` };
    }
    const occ = unitAt(state, step);
    if (occ && occ.id !== unit.id) {
      if (occ.owner !== unit.owner) {
        return { ok: false, reason: 'path crosses enemy unit' };
      }
      // friendly passthrough OK on intermediate tiles
    }
    prev = step;
  }
  return { ok: true, cost };
}

/**
 * Validate a candidate path: each step must be 4-adjacent, total cost ≤
 * budget, all tiles in-bounds, no enemy units crossed, destination not
 * occupied by another unit. Returns the total path cost or null if invalid.
 *
 * `path` excludes the start tile and includes the destination.
 */
export function validatePath(
  state: GameState,
  unit: Unit,
  path: Coord[],
): { ok: true; cost: number } | { ok: false; reason: string } {
  if (path.length === 0) {
    return { ok: true, cost: 0 };
  }
  const budget = UNITS[unit.type].move;
  let cost = 0;
  let prev = unit.pos;
  for (let i = 0; i < path.length; i++) {
    const step = path[i];
    if (!step) return { ok: false, reason: 'undefined path step' };
    const dx = Math.abs(step.x - prev.x);
    const dy = Math.abs(step.y - prev.y);
    if (dx + dy !== 1) {
      return { ok: false, reason: `non-adjacent step at index ${i}` };
    }
    const c = stepCost(state, unit, step);
    if (!isFinite(c)) {
      return { ok: false, reason: `impassable tile at index ${i}` };
    }
    cost += c;
    if (cost > budget) {
      return { ok: false, reason: `exceeds move budget (${cost} > ${budget})` };
    }
    const occ = unitAt(state, step);
    if (occ && occ.id !== unit.id) {
      const isLast = i === path.length - 1;
      if (isLast) {
        return { ok: false, reason: 'destination occupied' };
      }
      if (occ.owner !== unit.owner) {
        return { ok: false, reason: 'path crosses enemy unit' };
      }
      // friendly passthrough OK
    }
    prev = step;
  }
  return { ok: true, cost };
}
