// Derived-data selectors. Pure functions over GameState — never mutate.

import type { Coord, GameState, PlayerId, Unit, UnitId } from '../core/types';
import { coordEq, coordKey, inBounds, manhattan, unitAt } from '../core/types';
import { UNITS } from '../data';
import { reachableTiles } from '../systems/pathfinding';
import type { ReachableTile } from '../systems/pathfinding';

export { reachableTiles };
export type { ReachableTile };

// ─────────────────────────── Fog-of-war: visibility ──────────────────────────

/**
 * Static-vision contribution from owned capturable tiles (city / hq / factory).
 * AW lets a player see their own property's tile plus its 4-orthogonal
 * neighbours. Air tiles aren't a thing here; sea is always visible from a
 * coastal property.
 */
const PROPERTY_VISION_RANGE = 1;

/**
 * Submerged submarines have shrunken vision: they can only see their own tile
 * and adjacent. (Their full surfaced vision is in `UNITS[submarine].visionRange`.)
 */
const SUBMERGED_VISION_RANGE = 1;

/**
 * Bonus added to a unit's `visionRange` when it stands on a `mountain` tile —
 * classic Advance Wars rule. Mountain is impassable to wheel/tread/sea, so in
 * practice this fires for foot infantry (and the occasional air unit that
 * ends a turn there).
 */
const MOUNTAIN_VISION_BONUS = 3;

/** Per-state, per-player visibleTiles cache. Cleared via state identity. */
const visibleTilesCache = new WeakMap<GameState, Map<PlayerId, Set<string>>>();

/**
 * Tiles visible to `player` under fog-of-war rules. Returns a Set of `"x,y"`
 * keys (use `coordKey` to build matching keys).
 *
 *   - Every owned non-cargo unit contributes a Manhattan-radius disk of
 *     vision equal to its `UNITS[type].visionRange` (submerged subs see only
 *     Manhattan-1).
 *   - Every owned capturable tile (city / hq / factory) contributes a
 *     Manhattan-1 disk centred on itself.
 *
 * Result is memoised on `state` identity so the renderer and the engine can
 * call it once per frame without re-walking units.
 */
export function visibleTiles(
  state: GameState,
  player: PlayerId,
): Set<string> {
  let byPlayer = visibleTilesCache.get(state);
  if (byPlayer) {
    const hit = byPlayer.get(player);
    if (hit) return hit;
  } else {
    byPlayer = new Map<PlayerId, Set<string>>();
    visibleTilesCache.set(state, byPlayer);
  }

  const out = new Set<string>();
  const w = state.map[0]?.length ?? 0;
  const h = state.map.length;

  const addDisk = (centre: Coord, r: number): void => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > r) continue;
        const x = centre.x + dx;
        const y = centre.y + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        out.add(`${x},${y}`);
      }
    }
  };

  for (const u of Object.values(state.units)) {
    if (u.owner !== player) continue;
    if (u.loadedIn !== undefined) continue;
    const stats = UNITS[u.type];
    let r: number;
    if (u.type === 'submarine' && u.submerged === true) {
      r = SUBMERGED_VISION_RANGE;
    } else {
      r = stats.visionRange;
      if (state.map[u.pos.y]?.[u.pos.x]?.terrain === 'mountain') {
        r += MOUNTAIN_VISION_BONUS;
      }
    }
    addDisk(u.pos, r);
  }

  for (let y = 0; y < h; y++) {
    const row = state.map[y]!;
    for (let x = 0; x < w; x++) {
      const tile = row[x]!;
      if (tile.owner !== player) continue;
      if (tile.terrain !== 'city' && tile.terrain !== 'hq' && tile.terrain !== 'factory') {
        continue;
      }
      addDisk({ x, y }, PROPERTY_VISION_RANGE);
    }
  }

  byPlayer.set(player, out);
  return out;
}

/** Convenience: is the given coord visible to `player`? */
export function isTileVisible(
  state: GameState,
  c: Coord,
  player: PlayerId,
): boolean {
  return visibleTiles(state, player).has(coordKey(c));
}

/**
 * Sentinel `loadedIn` value stamped on enemy units that are out of the
 * viewer's vision in `viewStateForPlayer`. Picked so it can never collide
 * with a real unit id (real ids look like `u1`, `u2`, …).
 *
 * The engine treats any unit with `loadedIn !== undefined` as cargo (skipped
 * by `attackableTargets`, `unitAt`, threat-map computation, and pathfinding),
 * so a fog-hidden enemy is invisible to the AI's plan — exactly what we want.
 * Crucially `checkWinner` still COUNTS these units, which keeps the AI's
 * simulated reduces from triggering a spurious rout-win every time it
 * eliminates the last visible enemy on its plan.
 */
export const FOG_HIDDEN_SENTINEL = '__fog_hidden__';

/**
 * Returns a shallow-cloned GameState where every visible enemy unit is
 * present in `units` exactly as it appears in the truth state, but hidden
 * enemy units are stamped with `loadedIn = FOG_HIDDEN_SENTINEL`. Own units
 * are untouched.
 *
 * Map, players, turn etc. are passed through by reference. Used by the AI
 * to plan under imperfect information: the AI receives this state in place
 * of the truth, so all its existing `state.units` reads automatically
 * respect fog without needing per-call-site filtering.
 *
 * The sentinel trick (rather than deleting hidden enemies from the dict) is
 * load-bearing: `checkWinner` counts units regardless of `loadedIn`, so
 * leaving them in the dict prevents the AI's `reduce()` simulations from
 * declaring a fake rout-win whenever the player's view doesn't include any
 * enemy unit.
 */
export function viewStateForPlayer(
  state: GameState,
  player: PlayerId,
): GameState {
  const visible = visibleTiles(state, player);
  const filtered: Record<UnitId, Unit> = {};
  for (const u of Object.values(state.units)) {
    if (u.owner === player) {
      filtered[u.id] = u;
      continue;
    }
    // Enemy cargo: stays cargo. The AI sees the carrier (subject to fog)
    // but not the manifest, mirroring real Fog rules.
    if (u.loadedIn !== undefined) {
      filtered[u.id] = u;
      continue;
    }
    let hidden = !visible.has(coordKey(u.pos));
    if (!hidden && u.type === 'submarine' && u.submerged === true) {
      // Submerged-sub stealth layers on top of the vision disk.
      let spotted = false;
      for (const other of Object.values(state.units)) {
        if (other.owner !== player) continue;
        if (other.loadedIn !== undefined) continue;
        if (other.type !== 'cruiser' && other.type !== 'submarine') continue;
        if (manhattan(other.pos, u.pos) <= 1) {
          spotted = true;
          break;
        }
      }
      if (!spotted) hidden = true;
    }
    filtered[u.id] = hidden ? { ...u, loadedIn: FOG_HIDDEN_SENTINEL } : u;
  }
  return { ...state, units: filtered };
}

/**
 * Hidden tiles from `player`'s perspective — complement of `visibleTiles`.
 * Returns a Set of `"x,y"` coord keys covering every map tile not currently
 * in the visibility disk. Used by the fog-aware AI to apply a phantom-threat
 * baseline (so the AI doesn't blindly march into unknown territory).
 */
export function hiddenTiles(
  state: GameState,
  player: PlayerId,
): Set<string> {
  const visible = visibleTiles(state, player);
  const out = new Set<string>();
  const w = state.map[0]?.length ?? 0;
  const h = state.map.length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = `${x},${y}`;
      if (!visible.has(k)) out.add(k);
    }
  }
  return out;
}

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
 * Whether the unit `unit` is visible to player `observer`.
 *
 *   - Own units → always visible.
 *   - Submerged enemy submarines (existing rule) → visible only if observer
 *     owns a cruiser/submarine within Manhattan distance 1 of the sub.
 *   - Otherwise: when `fog` is false, always visible (omniscience — current
 *     pre-fog behaviour). When `fog` is true, visible iff the unit's tile is
 *     in `visibleTiles(state, observer)`.
 */
export function isVisibleTo(
  state: GameState,
  unit: Unit,
  observer: PlayerId,
  fog: boolean = false,
): boolean {
  if (unit.owner === observer) return true;
  if (unit.type === 'submarine' && unit.submerged === true) {
    // Submarine stealth: ignore fog disk; only spotter adjacency reveals.
    for (const other of Object.values(state.units)) {
      if (other.owner !== observer) continue;
      if (other.loadedIn !== undefined) continue;
      if (other.type !== 'cruiser' && other.type !== 'submarine') continue;
      if (manhattan(other.pos, unit.pos) <= 1) return true;
    }
    return false;
  }
  if (!fog) return true;
  return isTileVisible(state, unit.pos, observer);
}

/**
 * Viewer-aware lookup: which unit (if any) is visible to `viewer` at
 * coordinate `c`. A submerged enemy submarine on `c` is hidden unless the
 * viewer has a spotter (cruiser/submarine) within Manhattan distance 1.
 * Under fog (`fog: true`), enemy units whose tile is outside `visibleTiles`
 * are also masked.
 *
 * Renderer + input controller consume this; the reducer still operates on
 * the unmasked truth via `unitAt`.
 */
export function visibleUnitAt(
  state: GameState,
  c: Coord,
  viewer: PlayerId,
  fog: boolean = false,
): Unit | undefined {
  for (const u of Object.values(state.units)) {
    if (u.loadedIn !== undefined) continue;
    if (!coordEq(u.pos, c)) continue;
    if (!isVisibleTo(state, u, viewer, fog)) continue;
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
