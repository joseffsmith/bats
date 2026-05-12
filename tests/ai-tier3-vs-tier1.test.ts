// Phase 5 ACCEPTANCE.
//
// Tier 3 (threatMap + roles) must beat Tier 1 (plain utility) at least 7 of
// 10 matches on BOTH the duel map and the crossroads map. "Win" matches the
// tournament harness's adjudication: a raw rout/HQ-capture, OR a tied turn
// cap broken by (a) more HQ tiles owned, then (b) higher total unit cost.
//
// We also re-check the per-turn AI budget: no individual takeTurn() may run
// more than 200ms.

import { describe, expect, it } from 'vitest';
import './test-helpers';

import duelMap from '../src/data/maps/duel.json';
import crossroadsMap from '../src/data/maps/crossroads.json';
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

async function tierThreeWins(
  mapJson: unknown,
  mapName: string,
  seeds: ReadonlyArray<number>,
): Promise<{ wins: number; maxTurnMs: number }> {
  let wins = 0;
  let maxTurnMs = 0;
  for (const seed of seeds) {
    const result = await runMatch({
      mapName,
      maxTurns: 200,
      seed,
      mapJson,
      writeLog: false,
      p0: { name: 'tier3' },
      p1: { name: 'tier1' },
    });
    const verdict = adjudicate(result.finalState, result.winner);
    if (verdict === 0) wins += 1;
    for (const t of result.timings) {
      if (t.aiElapsedMs > maxTurnMs) maxTurnMs = t.aiElapsedMs;
    }
  }
  return { wins, maxTurnMs };
}

describe('Phase 5 acceptance: tier3 vs tier1', () => {
  it('tier3 wins ≥7/10 on duel with seeds 1..10', async () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const { wins, maxTurnMs } = await tierThreeWins(duelMap, 'duel', seeds);
    expect(wins).toBeGreaterThanOrEqual(7);
    expect(maxTurnMs).toBeLessThan(200);
  }, 180_000);

  it('tier3 wins ≥7/10 on crossroads with seeds 11..20', async () => {
    const seeds = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const { wins, maxTurnMs } = await tierThreeWins(
      crossroadsMap,
      'crossroads',
      seeds,
    );
    expect(wins).toBeGreaterThanOrEqual(7);
    expect(maxTurnMs).toBeLessThan(200);
  }, 600_000);
});
