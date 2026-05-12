// Income at end of turn + build legality + unit cost lookup.

import type { GameState, PlayerId, UnitType } from '../core/types';
import { INCOME_PER_PROPERTY, INCOME_TERRAIN, UNITS } from '../data-inline';
import { log } from '../core/logger';

export function unitCost(type: UnitType): number {
  return UNITS[type].cost;
}

/** Count income-producing properties (city, hq, factory) owned by `player`. */
export function countProperties(state: GameState, player: PlayerId): number {
  let n = 0;
  for (const row of state.map) {
    for (const tile of row) {
      if (tile.owner !== player) continue;
      if (INCOME_TERRAIN.includes(tile.terrain)) n++;
    }
  }
  return n;
}

/** Compute the income a player would receive at end-of-turn. */
export function computeIncome(state: GameState, player: PlayerId): number {
  return countProperties(state, player) * INCOME_PER_PROPERTY;
}

/**
 * Grant income to `player`. Mutates `state.players[player].funds`. Caller
 * passes deep-cloned state.
 */
export function grantIncome(state: GameState, player: PlayerId): number {
  const income = computeIncome(state, player);
  const ps = state.players[player];
  ps.funds += income;
  log('engine', 'income granted', { player, income, funds: ps.funds });
  return income;
}
