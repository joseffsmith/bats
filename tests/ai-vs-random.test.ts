// Phase 4 acceptance test.
//
// Utility AI must beat Random AI 10-0 over 10 matches on the duel map
// (seeds 1..10). Each AI's `takeTurn` must complete in <200ms.
//
// We measure `takeTurn` time only — reducer/log/io are excluded.

import { describe, expect, it } from 'vitest';
import './test-helpers';

import duelMap from '../src/data/maps/duel.json';
import { runMatch } from '../src/cli/run-match';

function bench<T>(fn: () => T): { value: T; ms: number } {
  const start = process.hrtime.bigint();
  const value = fn();
  const end = process.hrtime.bigint();
  return { value, ms: Number(end - start) / 1e6 };
}

describe('Phase 4 acceptance: utility vs random', () => {
  it('utility wins all 10 matches on duel with seeds 1..10', async () => {
    let utilityWins = 0;
    let maxAiTurnMs = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const result = await runMatch({
        mapName: 'duel',
        maxTurns: 200,
        seed,
        mapJson: duelMap,
        writeLog: false,
        p0: { name: 'utility' },
        p1: { name: 'random' },
      });
      if (result.winner === 0) utilityWins += 1;
      for (const t of result.timings) {
        if (t.aiElapsedMs > maxAiTurnMs) maxAiTurnMs = t.aiElapsedMs;
      }
    }
    expect(utilityWins).toBe(10);
    // No individual AI.takeTurn() may exceed 200ms.
    expect(maxAiTurnMs).toBeLessThan(200);
    // Smoke check: bench helper itself records ms via hrtime.
    const probe = bench(() => 1 + 1);
    expect(typeof probe.ms).toBe('number');
  }, 60_000);
});
