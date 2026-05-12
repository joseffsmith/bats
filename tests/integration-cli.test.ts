// Phase 2 end-to-end CLI integration test.
//
// Drives `runMatch` programmatically (no subprocess) on the duel map. We
// assert (a) the match terminates inside maxTurns; (b) two runs with the
// same seed produce identical action logs.

import { describe, expect, it } from 'vitest';
import './test-helpers';

import duelJson from '../src/data/maps/duel.json';
import crossroadsJson from '../src/data/maps/crossroads.json';
import { runMatch } from '../src/cli/run-match';

describe('cli integration: stub-AI match', () => {
  it('completes a duel match within 200 turns from seed=1', async () => {
    const result = await runMatch({
      mapName: 'duel',
      maxTurns: 200,
      seed: 1,
      mapJson: duelJson,
      writeLog: false,
    });
    expect(result.turns).toBeLessThanOrEqual(200);
    // Match should have produced some action history.
    expect(result.actions.length).toBeGreaterThan(0);
    // Either someone won, or we hit the cap.
    expect(result.winner === null || result.winner === 0 || result.winner === 1).toBe(true);
  });

  it('is deterministic: same seed produces an identical action log', async () => {
    const a = await runMatch({
      mapName: 'duel',
      maxTurns: 200,
      seed: 7,
      mapJson: duelJson,
      writeLog: false,
    });
    const b = await runMatch({
      mapName: 'duel',
      maxTurns: 200,
      seed: 7,
      mapJson: duelJson,
      writeLog: false,
    });
    expect(b.actions).toEqual(a.actions);
    expect(b.turns).toBe(a.turns);
    expect(b.winner).toBe(a.winner);
    expect(b.unitCount).toEqual(a.unitCount);
    expect(b.funds).toEqual(a.funds);
  });

  it('different seeds produce different traces', async () => {
    const a = await runMatch({
      mapName: 'duel',
      maxTurns: 200,
      seed: 1,
      mapJson: duelJson,
      writeLog: false,
    });
    const b = await runMatch({
      mapName: 'duel',
      maxTurns: 200,
      seed: 2,
      mapJson: duelJson,
      writeLog: false,
    });
    // Vanishingly unlikely that two seeds yield identical action lists.
    expect(b.actions).not.toEqual(a.actions);
  });

  it('runs on crossroads.json too', async () => {
    const result = await runMatch({
      mapName: 'crossroads',
      maxTurns: 200,
      seed: 1,
      mapJson: crossroadsJson,
      writeLog: false,
    });
    expect(result.turns).toBeLessThanOrEqual(200);
    expect(result.actions.length).toBeGreaterThan(0);
  });
});
