// CLI runner — promoted in Phase 4 from a stub-AI shim to a real AI host.
//
//   npx tsx src/cli/run-match.ts --map duel --max-turns 200 --seed 42 \
//     --p0 utility --p1 random
//
// Drives an engine match using two pluggable AIs from `src/engine/ai`. The
// AI is asked for a full turn sequence at a time; the runner splats it into
// the reducer. We log the AI name, sequence length, and per-turn elapsed
// (utility.takeTurn time only — not reducer time) so the acceptance budget
// of <200ms per turn is enforceable.
//
// `runMatch` is the headless API the tests + tournament call.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMap, loadAIWeights } from '../engine/data/loader';
import type { AIWeights } from '../engine/data/loader';
import { AI_WEIGHTS, INCOME_TERRAIN } from '../engine/data';
import { reduce } from '../engine/core/reducer';
import { createRng } from '../engine/core/rng';
import { randomAI } from '../engine/ai/random';
import { utilityAI } from '../engine/ai/utility';
import type { AI } from '../engine/ai/types';
import type {
  Action,
  GameState,
  PlayerId,
} from '../engine/core/types';
import { log, setLogEnabled } from '../engine/core/logger';

// ─────────────────────────── AI registry ─────────────────────────────────────

export type AIName = 'random' | 'utility';

export const AI_NAMES: ReadonlyArray<AIName> = ['random', 'utility'];

export function isAIName(s: string): s is AIName {
  return AI_NAMES.includes(s as AIName);
}

export type AISpec = {
  name: AIName;
  /** Custom utility weights, ignored by other AIs. */
  weights?: AIWeights;
};

export function makeAI(spec: AISpec): AI {
  if (spec.name === 'random') return randomAI({ name: 'random' });
  if (spec.name === 'utility') {
    const opts: Record<string, unknown> = { name: 'utility' };
    if (spec.weights) opts.weights = spec.weights;
    return utilityAI(opts);
  }
  throw new Error(`unknown AI name: ${spec.name as string}`);
}

// ─────────────────────────── Public types ────────────────────────────────────

export type RunMatchOptions = {
  mapName: string;
  /** Hard cap on number of turns (each END_TURN counts as one). */
  maxTurns: number;
  seed: number;
  /** AI for player 0. Defaults to `utility`. */
  p0?: AISpec;
  /** AI for player 1. Defaults to `random`. */
  p1?: AISpec;
  /** Pre-loaded map JSON. If omitted, the runner reads `src/data/maps/<mapName>.json`. */
  mapJson?: unknown;
  /** If false, no logs/*.jsonl file is written. Default true. */
  writeLog?: boolean;
  /** Base directory for log output. Defaults to `<cwd>/logs`. */
  logDir?: string;
};

export type ActionLogEntry = {
  turn: number;
  player: PlayerId;
  action: Action;
};

export type TurnTimingEntry = {
  turn: number;
  player: PlayerId;
  aiName: string;
  actions: number;
  /** Time spent inside `ai.takeTurn` — excludes reducer dispatch. */
  aiElapsedMs: number;
};

export type RunMatchResult = {
  finalState: GameState;
  turns: number;
  winner: PlayerId | null;
  unitCount: Record<PlayerId, number>;
  funds: Record<PlayerId, number>;
  elapsedMs: number;
  actions: ActionLogEntry[];
  timings: TurnTimingEntry[];
  logPath: string | null;
};

// ─────────────────────────── Match runner ────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(SRC_ROOT, '..');

async function readMapJson(mapName: string): Promise<unknown> {
  const file = path.join(SRC_ROOT, 'data', 'maps', `${mapName}.json`);
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text);
}

/** Cross-platform monotonic clock in ms (fractional). */
function nowMs(): number {
  if (typeof process !== 'undefined' && process.hrtime?.bigint) {
    return Number(process.hrtime.bigint()) / 1e6;
  }
  return Date.now();
}

/**
 * Run a match to completion (or maxTurns) with two pluggable AIs.
 *
 * Determinism: the two AIs receive distinct RNGs derived from `seed` so a
 * given (seed, p0, p1) tuple always produces the same action log.
 */
export async function runMatch(opts: RunMatchOptions): Promise<RunMatchResult> {
  const writeLog = opts.writeLog ?? true;
  const logDir = opts.logDir ?? path.join(PROJECT_ROOT, 'logs');

  const mapJson = opts.mapJson ?? (await readMapJson(opts.mapName));
  const state0 = loadMap(mapJson);

  const p0Spec: AISpec = opts.p0 ?? { name: 'utility' };
  const p1Spec: AISpec = opts.p1 ?? { name: 'random' };
  const ai0 = makeAI(p0Spec);
  const ai1 = makeAI(p1Spec);
  const ais: Record<PlayerId, AI> = { 0: ai0, 1: ai1 };

  // Separate seeded RNGs per player so each AI's stochasticity is independent.
  const rngs: Record<PlayerId, ReturnType<typeof createRng>> = {
    0: createRng(opts.seed * 2 + 1),
    1: createRng(opts.seed * 2 + 2),
  };

  const start = Date.now();
  let state = state0;
  const actions: ActionLogEntry[] = [];
  const timings: TurnTimingEntry[] = [];

  // Each `loop` iteration plans + applies one full turn for the current
  // player. A turn = the AI's full Action[] up to and including END_TURN.
  let safetyLoops = 0;
  while (state.winner === null && state.turn <= opts.maxTurns) {
    safetyLoops += 1;
    if (safetyLoops > opts.maxTurns * 4) break; // shouldn't happen

    const player = state.currentPlayer;
    const ai = ais[player];
    const rng = rngs[player];
    const turnAtStart = state.turn;

    const aiStart = nowMs();
    const plan = ai.takeTurn({ state, player, rng });
    const aiElapsedMs = nowMs() - aiStart;
    timings.push({
      turn: turnAtStart,
      player,
      aiName: ai.name,
      actions: plan.length,
      aiElapsedMs,
    });
    log('match', 'ai plan', {
      turn: turnAtStart,
      player,
      ai: ai.name,
      actions: plan.length,
      aiElapsedMs: Number(aiElapsedMs.toFixed(2)),
    });

    let endedTurn = false;
    for (const action of plan) {
      const next = reduce(state, action);
      const changed = next !== state;
      if (changed) {
        actions.push({ turn: turnAtStart, player, action });
        state = next;
      }
      if (action.type === 'END_TURN') {
        endedTurn = true;
        break;
      }
      if (state.winner !== null) {
        endedTurn = true;
        break;
      }
    }
    // Safety: if the AI's plan didn't end with END_TURN (bug), force-end the
    // turn so we don't loop forever on the same player.
    if (!endedTurn && state.winner === null) {
      const forced: Action = { type: 'END_TURN' };
      const next = reduce(state, forced);
      if (next !== state) {
        actions.push({ turn: turnAtStart, player, action: forced });
        state = next;
      } else {
        // Truly stuck — bail.
        break;
      }
    }
  }

  const elapsedMs = Date.now() - start;
  const unitCount: Record<PlayerId, number> = { 0: 0, 1: 0 };
  for (const u of Object.values(state.units)) unitCount[u.owner] += 1;
  const funds: Record<PlayerId, number> = {
    0: state.players[0].funds,
    1: state.players[1].funds,
  };

  let logPath: string | null = null;
  if (writeLog) {
    await fs.mkdir(logDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    logPath = path.join(logDir, `match-${ts}-${opts.seed}.jsonl`);
    const header = {
      type: 'header',
      map: opts.mapName,
      seed: opts.seed,
      maxTurns: opts.maxTurns,
      p0: p0Spec.name,
      p1: p1Spec.name,
      startedAt: new Date().toISOString(),
    };
    const summary = {
      type: 'summary',
      turns: state.turn,
      winner: state.winner,
      unitCount,
      funds,
      elapsedMs,
    };
    const lines: string[] = [JSON.stringify(header)];
    for (const a of actions) lines.push(JSON.stringify({ type: 'action', ...a }));
    lines.push(JSON.stringify(summary));
    await fs.writeFile(logPath, lines.join('\n') + '\n', 'utf8');
  }

  log('match', 'match complete', {
    turns: state.turn,
    winner: state.winner,
    elapsedMs,
  });

  return {
    finalState: state,
    turns: state.turn,
    winner: state.winner,
    unitCount,
    funds,
    elapsedMs,
    actions,
    timings,
    logPath,
  };
}

// ─────────────────────────── Argv parsing + entry ────────────────────────────

type ParsedArgs = {
  map: string;
  maxTurns: number;
  seed: number;
  quiet: boolean;
  p0: AIName;
  p1: AIName;
  p0WeightsPath?: string;
  p1WeightsPath?: string;
};

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const defaults: ParsedArgs = {
    map: 'duel',
    maxTurns: 200,
    seed: 1,
    quiet: false,
    p0: 'utility',
    p1: 'random',
  };
  const out: ParsedArgs = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--map') {
      const v = argv[++i];
      if (!v) throw new Error('--map requires a value');
      out.map = v;
    } else if (a === '--max-turns') {
      const v = argv[++i];
      if (!v) throw new Error('--max-turns requires a value');
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad --max-turns: ${v}`);
      out.maxTurns = n;
    } else if (a === '--seed') {
      const v = argv[++i];
      if (!v) throw new Error('--seed requires a value');
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n)) throw new Error(`bad --seed: ${v}`);
      out.seed = n;
    } else if (a === '--p0') {
      const v = argv[++i];
      if (!v || !isAIName(v)) throw new Error(`--p0 requires one of: ${AI_NAMES.join(', ')}`);
      out.p0 = v;
    } else if (a === '--p1') {
      const v = argv[++i];
      if (!v || !isAIName(v)) throw new Error(`--p1 requires one of: ${AI_NAMES.join(', ')}`);
      out.p1 = v;
    } else if (a === '--p0-weights') {
      const v = argv[++i];
      if (!v) throw new Error('--p0-weights requires a path');
      out.p0WeightsPath = v;
    } else if (a === '--p1-weights') {
      const v = argv[++i];
      if (!v) throw new Error('--p1-weights requires a path');
      out.p1WeightsPath = v;
    } else if (a === '--quiet') {
      out.quiet = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a as string}`);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(
    [
      'Usage: tsx src/cli/run-match.ts [options]',
      '',
      '  --map <name>          map to load (default: duel)',
      '  --max-turns <N>       hard turn cap (default: 200)',
      '  --seed <N>            RNG seed (default: 1)',
      '  --p0 <name>           AI for player 0: random | utility (default: utility)',
      '  --p1 <name>           AI for player 1: random | utility (default: random)',
      '  --p0-weights <path>   JSON file of utility weights for player 0',
      '  --p1-weights <path>   JSON file of utility weights for player 1',
      '  --quiet               suppress per-action log lines',
      '  --help, -h            show this help',
    ].join('\n'),
  );
}

async function loadWeights(p?: string): Promise<AIWeights | undefined> {
  if (!p) return undefined;
  const text = await fs.readFile(p, 'utf8');
  return loadAIWeights(JSON.parse(text));
}

function countProperties(state: GameState, player: PlayerId): number {
  let n = 0;
  for (const row of state.map) {
    for (const tile of row) {
      if (tile.owner !== player) continue;
      if (INCOME_TERRAIN.includes(tile.terrain)) n += 1;
    }
  }
  return n;
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv);
  if (args.quiet) {
    setLogEnabled('engine', false);
    setLogEnabled('match', false);
    setLogEnabled('ai', false);
  } else {
    setLogEnabled('engine', false);
  }

  const p0Weights = await loadWeights(args.p0WeightsPath);
  const p1Weights = await loadWeights(args.p1WeightsPath);

  console.log(
    `[match] starting map=${args.map} seed=${args.seed} p0=${args.p0} p1=${args.p1} maxTurns=${args.maxTurns}`,
  );
  const result = await runMatch({
    mapName: args.map,
    maxTurns: args.maxTurns,
    seed: args.seed,
    p0: { name: args.p0, ...(p0Weights ? { weights: p0Weights } : {}) },
    p1: { name: args.p1, ...(p1Weights ? { weights: p1Weights } : {}) },
  });

  const p0Props = countProperties(result.finalState, 0);
  const p1Props = countProperties(result.finalState, 1);
  const p0Turns = result.timings.filter((t) => t.player === 0);
  const p1Turns = result.timings.filter((t) => t.player === 1);
  const avg = (xs: TurnTimingEntry[]): number =>
    xs.length === 0 ? 0 : xs.reduce((s, t) => s + t.aiElapsedMs, 0) / xs.length;

  console.log('─────────────────────────────────────────────────');
  console.log(`map:             ${args.map}`);
  console.log(`seed:            ${args.seed}`);
  console.log(`turns played:    ${result.turns}`);
  console.log(`winner:          ${result.winner === null ? '(none — turn cap)' : `player ${result.winner}`}`);
  console.log(`elapsed:         ${result.elapsedMs} ms`);
  console.log(`units p0/p1:     ${result.unitCount[0]} / ${result.unitCount[1]}`);
  console.log(`funds p0/p1:     ${result.funds[0]} / ${result.funds[1]}`);
  console.log(`properties:      p0=${p0Props}  p1=${p1Props}`);
  console.log(
    `avg AI turn:     p0(${args.p0})=${avg(p0Turns).toFixed(1)}ms  p1(${args.p1})=${avg(p1Turns).toFixed(1)}ms`,
  );
  console.log(`log file:        ${result.logPath ?? '(none)'}`);
  console.log('─────────────────────────────────────────────────');

  // Reference AI_WEIGHTS to keep the import live for tree-shaking-naive builds.
  void AI_WEIGHTS;
}

// Detect "run as a script" without falling foul of ESM.
const isEntry =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntry) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[match] error: ${msg}`);
    process.exit(1);
  });
}
