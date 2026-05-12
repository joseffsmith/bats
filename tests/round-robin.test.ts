// Round-robin tournament smoke test.
//
// A 2-persona, 2-match, 1-map mini-tournament:
//   - completes,
//   - the per-pair sums equal the per-persona sums equal matchCount,
//   - the side balance check sums to matchCount.

import { describe, expect, it, beforeAll } from 'vitest';
import './test-helpers';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runRoundRobin } from '../src/cli/round-robin';

describe('round-robin mini-tournament', () => {
  let logDir: string;

  beforeAll(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  });

  it('completes a 2-persona × 2-match × 1-map run and sums correctly', async () => {
    const report = await runRoundRobin({
      personas: ['balanced', 'aggressor'],
      maps: ['duel'],
      matches: 2,
      maxTurns: 60,
      concurrency: 2,
      logDir,
    });

    // 1 pair × 1 map × 2 matches = 2 records total.
    expect(report.matchCount).toBe(2);
    expect(report.matches.length).toBe(2);

    // Pairings: only one unordered pair (balanced, aggressor).
    expect(report.pairings.length).toBe(1);
    const p = report.pairings[0]!;
    expect(p.aWins + p.bWins + p.draws).toBe(2);

    // Per-persona sums.
    let wTotal = 0, lTotal = 0, dTotal = 0;
    for (const r of report.records) {
      wTotal += r.wins;
      lTotal += r.losses;
      dTotal += r.draws;
    }
    // Every match yields ONE win+loss OR two draws (counted once per persona),
    // so wins + losses + draws_for_both = matches * 2.
    expect(wTotal + lTotal + dTotal).toBe(report.matchCount * 2);

    // Side balance sums to matchCount.
    expect(
      report.sideBalance.p0 + report.sideBalance.p1 + report.sideBalance.draws,
    ).toBe(report.matchCount);

    // Files on disk.
    expect(fs.existsSync(path.join(logDir, 'summary.tsv'))).toBe(true);
    expect(fs.existsSync(path.join(logDir, 'report.json'))).toBe(true);
  }, 120_000);

  it('rejects unknown persona', async () => {
    await expect(
      runRoundRobin({
        personas: ['nope'],
        maps: ['duel'],
        matches: 1,
        maxTurns: 30,
        logDir,
      }),
    ).rejects.toThrow(/unknown persona/);
  });
});
