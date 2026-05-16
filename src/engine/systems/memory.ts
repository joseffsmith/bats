// Fog-of-war: per-player "last-known position" memory.
//
// When a game starts with fog on, callers invoke `enableFogMemory` to flip
// `state.players[p].seenEnemies` from `undefined` to `{}` on both players.
// The reducer then calls `updateSeenEnemies` after every legal action so the
// active player's memory stays in sync with their current vision:
//
//   - Currently-visible enemies → snapshot overwritten (fresh sighting).
//   - Ghost whose tile is now visible AND empty → deleted (positive
//     disproof: the scout actually walked over and saw it gone).
//   - Ghost whose tile is still hidden → carried forward unchanged.
//
// Non-fog games keep `seenEnemies` undefined; both helpers short-circuit so
// the reducer pays no cost and legacy saves stay clean of ghost data.

import type {
  GameState,
  PlayerId,
  PlayerState,
  SeenEnemy,
  UnitId,
} from '../core/types';
import { coordKey, unitAt } from '../core/types';
import { isVisibleTo, visibleTiles } from '../queries/selectors';

/**
 * Initialise per-player fog memory on `state`. After this returns,
 * `state.players[0].seenEnemies` and `state.players[1].seenEnemies` are
 * `{}` and the reducer's bookkeeping treats fog memory as active.
 *
 * Call once at game start when fog mode is on, before the first action.
 * Idempotent — calling on a state that already has memory enabled
 * returns the same shape.
 */
export function enableFogMemory(state: GameState): GameState {
  const players = {
    0: { ...state.players[0], seenEnemies: {} as Record<UnitId, SeenEnemy> },
    1: { ...state.players[1], seenEnemies: {} as Record<UnitId, SeenEnemy> },
  } satisfies Record<PlayerId, PlayerState>;
  return { ...state, players };
}

/**
 * Re-snapshot enemy visibility for `player` and prune disproven ghosts.
 * No-ops when `state.players[player].seenEnemies` is undefined.
 *
 * Pure: returns a new state, never mutates.
 */
export function updateSeenEnemies(
  state: GameState,
  player: PlayerId,
): GameState {
  const memory = state.players[player].seenEnemies;
  if (memory === undefined) return state;

  const next: Record<UnitId, SeenEnemy> = {};
  // Pass 1: refresh from currently-visible enemies.
  for (const u of Object.values(state.units)) {
    if (u.owner === player) continue;
    if (u.loadedIn !== undefined) continue;
    if (!isVisibleTo(state, u, player, /* fog */ true)) continue;
    next[u.id] = {
      unitId: u.id,
      type: u.type,
      owner: u.owner,
      pos: u.pos,
      hp: u.hp,
      lastSeenTurn: state.turn,
    };
  }
  // Pass 2: carry forward old ghosts unless positively disproven.
  const visible = visibleTiles(state, player);
  for (const [id, ghost] of Object.entries(memory)) {
    if (next[id] !== undefined) continue; // overwritten by fresh sighting
    const visibleHere = visible.has(coordKey(ghost.pos));
    if (visibleHere && unitAt(state, ghost.pos) === undefined) continue; // disproved
    next[id] = ghost;
  }

  return {
    ...state,
    players: {
      ...state.players,
      [player]: { ...state.players[player], seenEnemies: next },
    },
  };
}
