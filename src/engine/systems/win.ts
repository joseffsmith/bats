// HQ-capture or rout win detection. Pure: returns the winning PlayerId or
// null. The reducer is responsible for stamping the result onto state.winner
// and refusing further actions.

import type { GameState, PlayerId } from '../core/types';
import { otherPlayer, tileAt } from '../core/types';
import { log } from '../core/logger';

export function checkWinner(state: GameState): PlayerId | null {
  // HQ capture: if either HQ is owned by the opposing player.
  for (const p of [0, 1] as PlayerId[]) {
    const hqCoord = state.players[p].hq;
    const hqTile = tileAt(state.map, hqCoord);
    if (
      hqTile.terrain === 'hq' &&
      hqTile.owner !== null &&
      hqTile.owner !== p
    ) {
      log('engine', 'win detected (HQ capture)', {
        winner: hqTile.owner,
        loserHq: p,
      });
      return hqTile.owner;
    }
  }

  // Rout: any player with zero units loses. If BOTH players have zero units
  // (e.g. test fixture before any units spawned), no winner — return null.
  const counts: Record<number, number> = { 0: 0, 1: 0 };
  for (const u of Object.values(state.units)) {
    counts[u.owner] = (counts[u.owner] ?? 0) + 1;
  }
  if ((counts[0] ?? 0) === 0 && (counts[1] ?? 0) === 0) return null;
  for (const p of [0, 1] as PlayerId[]) {
    if ((counts[p] ?? 0) === 0) {
      const winner = otherPlayer(p);
      log('engine', 'win detected (rout)', { winner, loser: p });
      return winner;
    }
  }
  return null;
}
