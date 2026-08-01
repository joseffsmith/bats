// Match adjudication — who was ahead when the clock ran out.
//
// This is a QUERY, not a rule. `src/engine/systems/win.ts` remains the only
// thing that can produce a winner (HQ capture or rout), the reducer still has
// no turn cap, and nothing here ever writes to `state.winner`. Callers that
// impose a clock of their own ask this function who was ahead and present the
// answer themselves:
//
//   - the CLI harnesses' `--max-turns` (src/cli/round-robin.ts,
//     src/cli/tournament.ts — both import `adjudicate` from here);
//   - the shells' skirmish day cap (src/renderer/adjudication.ts).
//
// The ladder — lifted verbatim out of those two harnesses, which had duplicate
// copies of it, so tournament tables and live skirmishes score a position the
// same way:
//
//   1. a real winner wins;
//   2. else whoever owns more HQ tiles;
//   3. else whoever has more HP-weighted unit cost, by a margin > 1;
//   4. else a draw.

import type { GameState, PlayerId } from '../core/types';
import { UNITS } from '../data';

/** Adjudicated outcome: a player, or a draw when neither side is ahead. */
export type Verdict = PlayerId | 'draw';

/**
 * Minimum material lead (in funds) that counts as "ahead". A hair above zero
 * so float dust from the `hp / 100` weighting can't decide a match, and so two
 * armies that differ by less than a rounding error read as the draw they are.
 */
export const MATERIAL_MARGIN = 1;

/** HQ tiles `player` currently owns. Counts tiles, not the seat's own HQ: a
 *  captured enemy HQ ends the match outright, so in practice this separates
 *  "still holds their own" from "lost it and is playing on someone else's". */
export function hqTilesOwned(state: GameState, player: PlayerId): number {
  let n = 0;
  for (const row of state.map) {
    for (const tile of row) {
      if (tile.terrain === 'hq' && tile.owner === player) n += 1;
    }
  }
  return n;
}

/** Standing army value: build cost scaled by remaining HP. A tank at 50 HP is
 *  worth half a tank — damage is progress even when nothing died. */
export function materialValue(state: GameState, player: PlayerId): number {
  let n = 0;
  for (const u of Object.values(state.units)) {
    if (u.owner === player) n += UNITS[u.type].cost * (u.hp / 100);
  }
  return n;
}

/** Run the ladder over `state`. Pure; never mutates and never writes a winner. */
export function adjudicate(state: GameState): Verdict {
  if (state.winner !== null) return state.winner;
  const hq0 = hqTilesOwned(state, 0);
  const hq1 = hqTilesOwned(state, 1);
  if (hq0 !== hq1) return hq0 > hq1 ? 0 : 1;
  const c0 = materialValue(state, 0);
  const c1 = materialValue(state, 1);
  if (Math.abs(c0 - c1) > MATERIAL_MARGIN) return c0 > c1 ? 0 : 1;
  return 'draw';
}
