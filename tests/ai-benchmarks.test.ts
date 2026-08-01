// Frozen benchmark generation tests.
//
// Two jobs:
//   1. The i8 snapshot loads, is named `<persona>-i8`, and is a faithful copy
//      of the personas it was frozen from.
//   2. The containment contract: benchmarks (and probes) must NEVER leak into
//      `PERSONAS` / `PERSONA_NAMES`. Campaign mode validates mission opponents
//      against `PERSONA_NAMES` and renders that list in the UI, so the persona
//      roster is a public contract — it must not silently grow.

import { describe, expect, it } from 'vitest';
import './test-helpers';

import {
  BENCHMARKS,
  BENCHMARK_NAMES,
  benchmarkAI,
  isBenchmarkName,
} from '../src/engine/ai/benchmarks';
import { PERSONAS, PERSONA_NAMES, aiFromPersonaConfig } from '../src/engine/ai/personas';
import { PROBE_NAMES } from '../src/engine/ai/probes';
import { isAIName, AI_NAMES, makeAI } from '../src/cli/run-match';

const EXPECTED_BENCHMARKS = [
  'aggressor-i8',
  'balanced-i8',
  'economist-i8',
  'turtle-i8',
];

const FROZEN_DESCRIPTION =
  'Frozen at aff447e (iteration 8) — regression benchmark, do not tune.';

describe('persona roster contract', () => {
  // If this fails, someone added a persona (or leaked a probe/benchmark into
  // the registry). Campaign mode validates mission opponents against this
  // exact list — grow it deliberately, never by accident.
  it('PERSONA_NAMES is exactly the four shipped personas', () => {
    expect([...PERSONA_NAMES]).toEqual([
      'aggressor',
      'balanced',
      'economist',
      'turtle',
    ]);
  });

  it('no benchmark or probe name appears in PERSONAS', () => {
    for (const n of BENCHMARK_NAMES) {
      expect(n in PERSONAS).toBe(false);
      expect(PERSONA_NAMES).not.toContain(n);
    }
    for (const n of PROBE_NAMES) {
      expect(n in PERSONAS).toBe(false);
      expect(PERSONA_NAMES).not.toContain(n);
    }
  });

  it('no persona name appears in BENCHMARKS', () => {
    for (const n of PERSONA_NAMES) expect(n in BENCHMARKS).toBe(false);
  });
});

describe('i8 benchmarks', () => {
  it('loads all four, named with the -i8 suffix and sorted', () => {
    expect([...BENCHMARK_NAMES]).toEqual(EXPECTED_BENCHMARKS);
    expect(Object.keys(BENCHMARKS).sort()).toEqual(EXPECTED_BENCHMARKS);
  });

  it('each config self-reports its own -i8 name and the frozen description', () => {
    for (const n of BENCHMARK_NAMES) {
      const cfg = BENCHMARKS[n]!;
      expect(cfg.name).toBe(n);
      expect(cfg.description).toBe(FROZEN_DESCRIPTION);
    }
  });

  it('is a faithful snapshot: weights/roles/build policy match the live personas', () => {
    // True at the freeze commit by construction. When a persona is retuned
    // this assertion is EXPECTED to fail — that failure is the whole point of
    // the benchmark, and the fix is to delete this test's expectation for the
    // changed persona, not to re-freeze i8.
    for (const persona of PERSONA_NAMES) {
      const live = PERSONAS[persona]!;
      const frozen = BENCHMARKS[`${persona}-i8`]!;
      expect(frozen.weights).toEqual(live.weights);
      expect(frozen.roleMultipliers).toEqual(live.roleMultipliers);
      expect(frozen.buildPolicy).toEqual(live.buildPolicy);
    }
  });

  it('isBenchmarkName agrees with BENCHMARK_NAMES', () => {
    for (const n of BENCHMARK_NAMES) expect(isBenchmarkName(n)).toBe(true);
    expect(isBenchmarkName('balanced')).toBe(false);
    expect(isBenchmarkName('aggressor-i9')).toBe(false);
  });
});

describe('benchmarkAI', () => {
  it('builds an AI carrying the -i8 name', () => {
    for (const n of BENCHMARK_NAMES) {
      const ai = benchmarkAI(n);
      expect(ai.name).toBe(n);
      expect(typeof ai.takeTurn).toBe('function');
    }
  });

  it('rejects unknown benchmark names', () => {
    expect(() => benchmarkAI('nope')).toThrow(/unknown benchmark/);
  });

  it('accepts the fog option', () => {
    expect(benchmarkAI('balanced-i8', { fog: true }).name).toBe('balanced-i8');
  });
});

describe('aiFromPersonaConfig', () => {
  it('builds an AI straight from a config without registry lookup', () => {
    const ai = aiFromPersonaConfig(PERSONAS.balanced!);
    expect(ai.name).toBe('balanced');
  });
});

describe('AI registry wiring', () => {
  it('isAIName accepts personas, probes, and benchmarks', () => {
    for (const n of [...PERSONA_NAMES, ...PROBE_NAMES, ...BENCHMARK_NAMES]) {
      expect(isAIName(n)).toBe(true);
      expect(AI_NAMES).toContain(n);
    }
    expect(isAIName('definitely-not-an-ai')).toBe(false);
  });

  it('makeAI resolves probe and benchmark names', () => {
    for (const n of PROBE_NAMES) expect(makeAI({ name: n }).name).toBe(n);
    for (const n of BENCHMARK_NAMES) expect(makeAI({ name: n }).name).toBe(n);
  });

  it('makeAI still rejects garbage', () => {
    expect(() => makeAI({ name: 'nope' })).toThrow(/unknown AI name/);
  });
});
