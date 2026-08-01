// Frozen benchmark generations.
//
// Retuning a persona tells you it got better against the *other current*
// personas — which is exactly the measurement that lets a whole generation
// drift sideways. A benchmark is a snapshot of a past generation's configs,
// pinned forever, so "is the new tune actually stronger than what we shipped?"
// is a question with an answer.
//
// `i8` is the iteration-8 generation, frozen at commit aff447e (see
// AI_TUNING.md). Its configs are byte-copies of `src/data/ai-personas.json` at
// that commit with `-i8`-suffixed names. They are load-bearing history: do not
// tune them, and do not "fix" them when the persona schema grows a field —
// add a new generation file instead.
//
// Benchmarks deliberately live OUTSIDE `PERSONAS` / `PERSONA_NAMES`. Campaign
// mode validates mission opponents against `PERSONA_NAMES` and renders that
// list in the UI; a benchmark leaking into it would surface "aggressor-i8" as
// a pickable opponent. They are reachable only through this module and the
// `run-match` AI registry (i.e. from the CLI and tuning harnesses).

import i8Json from '../../data/ai-benchmarks/i8.json';

import { aiFromPersonaConfig, loadPersonas } from './personas';
import type { PersonaConfig } from './personas';
import type { AI } from './types';

/**
 * Frozen benchmark configs, keyed by name. Validated through the ordinary
 * persona loader — a benchmark that no longer satisfies the persona schema is
 * a build-time failure, which is what we want: it means the schema changed
 * under us and the generation needs an explicit migration decision.
 */
export const BENCHMARKS: Record<string, PersonaConfig> = loadPersonas(i8Json);

/** Sorted benchmark names — stable order for CLI defaults and tests. */
export const BENCHMARK_NAMES: ReadonlyArray<string> = Object.keys(BENCHMARKS).sort();

export function isBenchmarkName(s: string): boolean {
  return s in BENCHMARKS;
}

/**
 * Build an AI driven by the named frozen benchmark config. Mirrors
 * `personaAI`'s signature; `fog` toggles fog-of-war planning.
 */
export function benchmarkAI(name: string, opts: { fog?: boolean } = {}): AI {
  const cfg = BENCHMARKS[name];
  if (!cfg) {
    throw new Error(
      `unknown benchmark "${name}" — available: ${BENCHMARK_NAMES.join(', ')}`,
    );
  }
  return aiFromPersonaConfig(cfg, opts);
}
