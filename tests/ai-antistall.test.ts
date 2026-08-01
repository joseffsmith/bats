// Anti-stall regression suite (iteration 9, WP5).
//
// The bug this file exists to keep dead: a symmetric utility-vs-utility match
// never terminated. Not "usually took a long time" — never. 725+ turns was
// simply where somebody got bored and killed it; the engine has no turn cap by
// design (the browser AI demo is meant to run forever), so nothing stopped it.
//
// Three shared-scoring mis-calibrations produced it, all visible in an
// `--trace=5` dump and all fixed in `utility.ts`:
//   1. capture progress was worth ~3 points while standing in an enemy's reach
//      cost ~50, so both armies parked one tile outside contact and stayed;
//   2. the act gate was `score > 0`, an absolute comparison that froze any
//      unit whose every option scored negative under a blanket threat map;
//   3. speculative `futureThreat` never expired, so a stand-off had no clock.
//
// The tournament harness cannot catch this (a match that never ends is never
// scored) and the doctrine suite cannot either (it asserts on single
// positions). It needs one real, full-length game — hence the ~2s outlier in
// an otherwise millisecond test suite. The full 5-seed × 2-map × 3-AI mirror
// matrix lives in the runbook, not here.

import { describe, expect, it } from 'vitest';
// Side-effect import: silences the engine/match log categories (a full match
// is ~2000 actions of console noise otherwise).
import './test-helpers';
import { runMatch } from '../src/cli/run-match';
import {
  counterRiskRamp,
  futureThreatRamp,
  pressureRamp,
} from '../src/engine/ai/utility';

describe('anti-stall: symmetric mirrors terminate', () => {
  it(
    'utility vs utility on duel reaches a raw winner well inside 600 turns',
    async () => {
      const r = await runMatch({
        mapName: 'duel',
        seed: 1,
        maxTurns: 600,
        p0: { name: 'utility' },
        p1: { name: 'utility' },
        writeLog: false,
      });
      // Raw winner — NOT the round-robin adjudicator's points decision. A
      // mirror must resolve on the board: HQ capture or rout.
      expect(
        r.winner,
        `mirror ran ${r.turns} turns without a winner (pre-iteration-9: forever)`,
      ).not.toBeNull();
      // Generous bound: the gate in AI_TUNING.md is <300 turns across five
      // seeds and both land maps; this asserts only that we are nowhere near
      // the old behaviour, so persona retunes don't trip it spuriously.
      expect(r.turns).toBeLessThan(300);
    },
    60_000,
  );
});

describe('anti-stall: the pressure ramp is a pure, bounded function of turn', () => {
  // The determinism suite requires the ramp to depend on nothing but
  // `state.turn`; these pin the shape so a future edit can't smuggle in
  // unbounded aggression or start the ramp during the opening.
  it('is neutral through the opening', () => {
    for (const turn of [0, 1, 10, 39, 40]) {
      expect(pressureRamp(turn)).toBe(1);
      expect(counterRiskRamp(turn)).toBe(1);
      expect(futureThreatRamp(turn)).toBe(1);
    }
  });

  it('is monotone and bounded once wound up', () => {
    let prevOffence = 1;
    let prevCounter = 1;
    let prevThreat = 1;
    for (let turn = 40; turn <= 400; turn += 5) {
      const offence = pressureRamp(turn);
      const counter = counterRiskRamp(turn);
      const threat = futureThreatRamp(turn);
      expect(offence).toBeGreaterThanOrEqual(prevOffence);
      expect(counter).toBeLessThanOrEqual(prevCounter);
      expect(threat).toBeLessThanOrEqual(prevThreat);
      expect(offence).toBeLessThanOrEqual(1.5);
      expect(counter).toBeGreaterThanOrEqual(0.5);
      expect(threat).toBeGreaterThanOrEqual(0);
      prevOffence = offence;
      prevCounter = counter;
      prevThreat = threat;
    }
    // Fully wound at the documented turn, and flat thereafter.
    expect(pressureRamp(90)).toBe(1.5);
    expect(pressureRamp(1000)).toBe(1.5);
    expect(futureThreatRamp(90)).toBe(0);
    expect(counterRiskRamp(90)).toBe(0.5);
  });

  it('is deterministic', () => {
    for (const turn of [7, 55, 88, 120]) {
      expect(pressureRamp(turn)).toBe(pressureRamp(turn));
      expect(counterRiskRamp(turn)).toBe(counterRiskRamp(turn));
      expect(futureThreatRamp(turn)).toBe(futureThreatRamp(turn));
    }
  });
});
