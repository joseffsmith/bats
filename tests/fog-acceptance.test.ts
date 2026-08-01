// Fog-of-war AI acceptance.
//
// Under fog, tier3 must still beat tier1 ≥7/10 on duel (the seed range used
// by ai-tier3-vs-tier1.test.ts). Mirrors that test but with `fog: true` on
// both AIs. crossroads is skipped to keep wall-time bounded; the duel run
// is the load-bearing acceptance gate for the fog feature.
//
// SECOND MAP (canyon). Added after the cross-map sweep in
// `scripts/fog-sweep.ts` — see the "Cross-map fog sweep" subsection of
// AI_TUNING.md. canyon is the cheapest non-duel map (~6s/match under fog,
// roughly half of crossroads), so it broadens the gate from one map to two
// for ~7s of wall-time.
//
// Two things the sweep established that shape what is asserted below:
//
//   1. SEEDS ARE INERT for utility-vs-utility. Neither tier1/tier2/tier3 nor
//      any persona reads `ctx.rng` — only `random` and the scripted probes do.
//      So the duel case's ten seeds are ten replays of ONE match and can only
//      score 10/10 or 0/10. The canyon case therefore runs a single match
//      rather than pretending a seed loop adds samples. (Re-check any time
//      with `npx tsx scripts/fog-sweep.ts --verify-seeds`.)
//   2. SIDE BALANCE IS NOT A FOG PROPERTY. On canyon, tier3 beats tier1 from
//      p0 and loses from p1 — but it does that with fog OFF too, identically.
//      So this asserts the p0 orientation the duel gate already pins; a
//      both-sides assertion would fail for reasons that have nothing to do
//      with fog. The fog-vs-no-fog equivalence is what the sweep measures.

import { describe, expect, it } from 'vitest';
import './test-helpers';

import canyonMap from '../src/data/maps/canyon.json';
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

  it('tier3 beats tier1 on canyon under fog', async () => {
    const result = await runMatch({
      mapName: 'canyon',
      maxTurns: 200,
      seed: 1,
      mapJson: canyonMap,
      writeLog: false,
      p0: { name: 'tier3', fog: true },
      p1: { name: 'tier1', fog: true },
    });
    expect(adjudicate(result.finalState, result.winner)).toBe(0);
  }, 60_000);
});
