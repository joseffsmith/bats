// Fog-of-war AI acceptance.
//
// Under fog, tier3 must still beat tier1 ≥7/10 on duel (the seed range used
// by ai-tier3-vs-tier1.test.ts). Mirrors that test but with `fog: true` on
// both AIs. crossroads is skipped to keep wall-time bounded; the duel run
// is the load-bearing acceptance gate for the fog feature.

import { describe, expect, it } from 'vitest';
import './test-helpers';

import duelMap from '../src/data/maps/duel.json';
import { runMatch } from '../src/cli/run-match';
import { UNITS } from '../src/engine/data';
import type { GameState, PlayerId } from '../src/engine/core/types';

function totalUnitCost(state: GameState, player: PlayerId): number {
  let n = 0;
  for (const u of Object.values(state.units)) {
    if (u.owner === player) n += UNITS[u.type].cost * (u.hp / 100);
  }
  return n;
}

function hqOwnedBy(state: GameState, player: PlayerId): number {
  let n = 0;
  for (const row of state.map) {
    for (const tile of row) {
      if (tile.terrain === 'hq' && tile.owner === player) n += 1;
    }
  }
  return n;
}

function adjudicate(state: GameState, rawWinner: PlayerId | null): PlayerId | 'draw' {
  if (rawWinner !== null) return rawWinner;
  const hq0 = hqOwnedBy(state, 0);
  const hq1 = hqOwnedBy(state, 1);
  if (hq0 !== hq1) return hq0 > hq1 ? 0 : 1;
  const c0 = totalUnitCost(state, 0);
  const c1 = totalUnitCost(state, 1);
  if (Math.abs(c0 - c1) > 1) return c0 > c1 ? 0 : 1;
  return 'draw';
}

describe('fog acceptance: tier3 vs tier1 with fog on', () => {
  it('tier3 wins ≥7/10 on duel with seeds 1..10 under fog', async () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    let wins = 0;
    for (const seed of seeds) {
      const result = await runMatch({
        mapName: 'duel',
        maxTurns: 200,
        seed,
        mapJson: duelMap,
        writeLog: false,
        p0: { name: 'tier3', fog: true },
        p1: { name: 'tier1', fog: true },
      });
      const verdict = adjudicate(result.finalState, result.winner);
      if (verdict === 0) wins += 1;
    }
    expect(wins).toBeGreaterThanOrEqual(7);
  }, 240_000);
});
