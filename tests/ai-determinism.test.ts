// Determinism: two runs of the same AI vs the same AI with the same seed
// must produce identical action logs. Anchors the "deterministic given a
// seed" guarantee in PLAN.md, which is essential for debugging and balance.

import { describe, expect, it } from 'vitest';
import './test-helpers';

import duelMap from '../src/data/maps/duel.json';
import { runMatch } from '../src/cli/run-match';

describe('AI determinism', () => {
  it('utility vs random with same seed: identical traces', async () => {
    const a = await runMatch({
      mapName: 'duel',
      maxTurns: 200,
      seed: 42,
      mapJson: duelMap,
      writeLog: false,
      p0: { name: 'utility' },
      p1: { name: 'random' },
    });
    const b = await runMatch({
      mapName: 'duel',
      maxTurns: 200,
      seed: 42,
      mapJson: duelMap,
      writeLog: false,
      p0: { name: 'utility' },
      p1: { name: 'random' },
    });
    expect(b.actions).toEqual(a.actions);
    expect(b.turns).toBe(a.turns);
    expect(b.winner).toBe(a.winner);
    expect(b.unitCount).toEqual(a.unitCount);
    expect(b.funds).toEqual(a.funds);
  });

  it('utility vs utility with same seed: identical traces', async () => {
    const a = await runMatch({
      mapName: 'duel',
      maxTurns: 200,
      seed: 9,
      mapJson: duelMap,
      writeLog: false,
      p0: { name: 'utility' },
      p1: { name: 'utility' },
    });
    const b = await runMatch({
      mapName: 'duel',
      maxTurns: 200,
      seed: 9,
      mapJson: duelMap,
      writeLog: false,
      p0: { name: 'utility' },
      p1: { name: 'utility' },
    });
    expect(b.actions).toEqual(a.actions);
    expect(b.turns).toBe(a.turns);
    expect(b.winner).toBe(a.winner);
  });

  it('random vs random with same seed: identical traces', async () => {
    const a = await runMatch({
      mapName: 'duel',
      maxTurns: 200,
      seed: 5,
      mapJson: duelMap,
      writeLog: false,
      p0: { name: 'random' },
      p1: { name: 'random' },
    });
    const b = await runMatch({
      mapName: 'duel',
      maxTurns: 200,
      seed: 5,
      mapJson: duelMap,
      writeLog: false,
      p0: { name: 'random' },
      p1: { name: 'random' },
    });
    expect(b.actions).toEqual(a.actions);
    expect(b.turns).toBe(a.turns);
    expect(b.winner).toBe(a.winner);
  });
});
