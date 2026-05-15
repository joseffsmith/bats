// Tier 2 threat-and-value precomputation.
//
// Both maps are 2D arrays sized [height][width] — i.e. indexed [y][x] to match
// `GameState.map`. They are computed ONCE at the start of an AI turn and read
// O(1) per candidate by the utility scorer. That's the whole point: replace the
// per-candidate O(enemies × reach × range) work in `futureThreat` /
// `positionalValue` with a constant-time table lookup.
//
// threatMap semantics
// ───────────────────
// `threatMap[y][x]` is the maximum single-turn damage an enemy unit could deal
// to a REPRESENTATIVE target standing at (x,y) on their next turn, assuming
// the enemy has not yet moved. The representative target is a generic
// mid-cost defender (tank, ~7000 cost, full HP) — picking any fixed reference
// keeps the map a function of the (state, attacker, target_player) tuple and
// the lookup tile's terrain alone.
//
// Algorithm:
//   For each enemy unit:
//     reach ← BFS expansion of its move range, ignoring enemy unit blockers
//             (worst-case for us — they might still get there next turn).
//     For each tile in reach:
//       For each tile (tx,ty) at Manhattan distance ∈ [minRange, maxRange]:
//         damage ← computeDamage(state, hypotheticalEnemyAtReachTile, repTargetAt(tx,ty))
//         threatMap[ty][tx] = max(threatMap[ty][tx], damage)
//
// We use `computeDamage` from `systems/combat` directly so the heuristic stays
// in lock-step with what the engine would actually compute.
//
// valueMap semantics
// ──────────────────
// `valueMap[y][x]` is a per-tile strategic bonus from the perspective of
// `forPlayer`. Composed of:
//
//   - HQ-attraction bonus: `max(0, 10 - manhattan((x,y), enemyHq))`
//   - Capturable bonus:    `+3` if the tile is capturable (city/hq/factory) and
//                          `tile.owner !== forPlayer` (i.e. neutral OR enemy-
//                          owned). HQ tiles included.
//   - Chokepoint bonus:    `+2 / +1 / +0.5 / 0` for tiles whose ground-passable
//                          orthogonal-neighbour count is 1 / 2 / 3 / 4. We
//                          average passability across the four GROUND movement
//                          classes (foot, wheel, tread). Air-only or sea-only
//                          tiles count as impassable for chokepoint purposes
//                          since we care about ground-unit movement here.
//
// Both maps are pure functions of `(state, player)` (or `(state, attacker,
// target)` for threat). The utility AI invalidates them whenever the state
// mutates and recomputes lazily.

import type { Coord, GameState, MovementClass, PlayerId, Unit } from '../core/types';
import { coordKey, inBounds, isCapturable, manhattan, otherPlayer, tileAt } from '../core/types';
import { TERRAIN, UNITS } from '../data';
import { computeDamage } from '../systems/combat';

export type ThreatMap = number[][];
export type ValueMap = number[][];

const NEIGHBOURS: ReadonlyArray<Coord> = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

/** Build a fresh [h][w] number grid pre-filled with `fill`. */
function makeGrid(state: GameState, fill: number): number[][] {
  const h = state.map.length;
  const w = state.map[0]?.length ?? 0;
  const out: number[][] = new Array(h);
  for (let y = 0; y < h; y++) {
    const row = new Array<number>(w);
    for (let x = 0; x < w; x++) row[x] = fill;
    out[y] = row;
  }
  return out;
}

/**
 * Threat map from `attackerPlayer`'s perspective: each tile's value is the max
 * damage any of `attackerPlayer`'s units could deal next turn to a generic
 * mid-cost defender (tank, full HP) standing on (x,y). `targetPlayer` is
 * carried for API symmetry — we use it only to set the representative target's
 * owner.
 *
 * O(enemies × reach × in-range-window). For typical states (~10 enemies, 50
 * reach tiles, ≤16 in-range tiles) this is well under a millisecond.
 */
export function computeThreatMap(
  state: GameState,
  attackerPlayer: PlayerId,
  targetPlayer: PlayerId,
): ThreatMap {
  const threat = makeGrid(state, 0);
  const h = threat.length;
  const w = threat[0]?.length ?? 0;
  if (h === 0 || w === 0) return threat;

  // Representative target: tank at full HP. We re-base its `pos` per lookup
  // tile so `computeDamage` reads that tile's defenseStars.
  const repTarget = (pos: Coord): Unit => ({
    id: '__threatmap_rep__',
    type: 'tank',
    owner: targetPlayer,
    pos,
    hp: 100,
    hasMoved: false,
    hasActed: false,
    captureProgress: 0,
  });

  for (const enemy of Object.values(state.units)) {
    if (enemy.owner !== attackerPlayer) continue;
    if (enemy.loadedIn !== undefined) continue; // cargo can't threaten
    const stats = UNITS[enemy.type];
    if (stats.maxRange <= 0) continue; // non-combat (transports)
    const reach = bfsReachIgnoringEnemyBlockers(state, enemy);

    for (const reachKey of reach) {
      const [rxs, rys] = reachKey.split(',');
      const rx = Number(rxs);
      const ry = Number(rys);
      const hypothetical: Unit = { ...enemy, pos: { x: rx, y: ry } };

      // For each tile in this enemy's attack window from (rx,ry).
      for (let dy = -stats.maxRange; dy <= stats.maxRange; dy++) {
        for (let dx = -stats.maxRange; dx <= stats.maxRange; dx++) {
          const d = Math.abs(dx) + Math.abs(dy);
          if (d < stats.minRange || d > stats.maxRange) continue;
          const tx = rx + dx;
          const ty = ry + dy;
          if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
          // Compute damage to the rep target standing on (tx,ty).
          const dmg = computeDamage(state, hypothetical, repTarget({ x: tx, y: ty }));
          if (dmg <= 0) continue;
          const row = threat[ty]!;
          if (dmg > row[tx]!) row[tx] = dmg;
        }
      }
    }
  }
  return threat;
}

/**
 * Strategic value map from `forPlayer`'s perspective. Composition is spelled
 * out at the top of the file. Higher value ≈ "more worth being on".
 */
export function computeValueMap(state: GameState, forPlayer: PlayerId): ValueMap {
  const value = makeGrid(state, 0);
  const h = value.length;
  const w = value[0]?.length ?? 0;
  if (h === 0 || w === 0) return value;

  const enemy = otherPlayer(forPlayer);
  const enemyHq = state.players[enemy].hq;
  const groundClasses: ReadonlyArray<MovementClass> = ['foot', 'wheel', 'tread'];

  for (let y = 0; y < h; y++) {
    const row = value[y]!;
    const mapRow = state.map[y]!;
    for (let x = 0; x < w; x++) {
      let v = 0;
      // HQ attraction: linear ramp, clamped at 10 within 0 distance.
      v += Math.max(0, 10 - manhattan({ x, y }, enemyHq));

      const tile = mapRow[x]!;
      if (isCapturable(tile.terrain) && tile.owner !== forPlayer) {
        v += 3;
      }

      // Chokepoint bonus: count orthogonal neighbours passable on average
      // across the three ground movement classes. A tile passable for
      // foot+wheel+tread counts as 1; foot-only counts as 1/3; impassable for
      // all counts as 0. We then take the integer floor of the sum to bucket.
      let neighbourScore = 0;
      for (const n of NEIGHBOURS) {
        const c: Coord = { x: x + n.x, y: y + n.y };
        if (!inBounds(state.map, c)) continue;
        const t = tileAt(state.map, c);
        const def = TERRAIN[t.terrain];
        let passClasses = 0;
        for (const cls of groundClasses) {
          if (Number.isFinite(def.moveCost[cls])) passClasses += 1;
        }
        neighbourScore += passClasses / groundClasses.length;
      }
      // Pure passable-neighbour count, rounded to nearest 0.5.
      const passableCount = Math.round(neighbourScore * 2) / 2;
      if (passableCount <= 1) v += 2;
      else if (passableCount <= 2) v += 1;
      else if (passableCount <= 3) v += 0.5;
      // 4-neighbour tiles get 0.

      row[x] = v;
    }
  }
  return value;
}

/**
 * BFS expansion of `unit`'s move budget over the terrain graph, ignoring all
 * unit blockers (worst-case threat assumption — the enemy might still get
 * there next turn after units have shuffled). Returns a Set of "x,y" keys
 * that includes the starting tile.
 *
 * Pure: does not mutate `state`. We don't use the engine's pathfinding here
 * because pathfinding gates on unit occupancy, which we deliberately ignore
 * for this worst-case scan.
 */
function bfsReachIgnoringEnemyBlockers(state: GameState, unit: Unit): Set<string> {
  const budget = UNITS[unit.type].move;
  const cls = UNITS[unit.type].movementClass;
  const dist = new Map<string, number>();
  const start = unit.pos;
  const startKey = coordKey(start);
  dist.set(startKey, 0);

  // Min-cost frontier; map size is small enough that linear scan beats a heap.
  const frontier = new Set<string>([startKey]);
  while (frontier.size > 0) {
    let bestKey: string | null = null;
    let bestCost = Infinity;
    for (const k of frontier) {
      const d = dist.get(k);
      if (d !== undefined && d < bestCost) {
        bestCost = d;
        bestKey = k;
      }
    }
    if (bestKey === null) break;
    frontier.delete(bestKey);
    const [bxs, bys] = bestKey.split(',');
    const here = { x: Number(bxs), y: Number(bys) };
    for (const n of NEIGHBOURS) {
      const cand: Coord = { x: here.x + n.x, y: here.y + n.y };
      if (!inBounds(state.map, cand)) continue;
      const tile = tileAt(state.map, cand);
      const cost = TERRAIN[tile.terrain].moveCost[cls];
      if (!Number.isFinite(cost)) continue;
      const total = bestCost + cost;
      if (total > budget) continue;
      const k = coordKey(cand);
      const ex = dist.get(k);
      if (ex === undefined || total < ex) {
        dist.set(k, total);
        frontier.add(k);
      }
    }
  }
  return new Set(dist.keys());
}

// Test/debug helpers.
export const __test = { bfsReachIgnoringEnemyBlockers };
