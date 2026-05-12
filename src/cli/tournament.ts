// Batch AI-vs-AI tournament harness.
//
//   npm run tournament -- --p0 utility --p1 random --map duel --matches 10
//
// Runs N matches, prints a summary table (wins/losses/draws, avg turns,
// avg AI time), and writes one JSONL log per match into
// `logs/tournament-<timestamp>/match-<i>.jsonl`.
//
// Draw detection: when a match hits the turn cap with no winner we declare a
// draw based on:
//   1. Owned HQ-tile count (each player owns their own unless the game is
//      decided — so this is normally 1-1).
//   2. Total unit cost on the board.
//   3. Falling through, the match is logged as a true draw.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMatch, isAIName, AI_NAMES } from './run-match';
import type { AIName, AISpec, RunMatchResult } from './run-match';
import { loadAIWeights } from '../engine/data/loader';
import type { AIWeights } from '../engine/data/loader';
import { UNITS } from '../engine/data';
import { setLogEnabled } from '../engine/core/logger';
import type { GameState, PlayerId } from '../engine/core/types';

// ─────────────────────────── Public types ────────────────────────────────────

export type MatchOutcome = {
  seed: number;
  map: string;
  /** True winner, or null if the match was capped. */
  rawWinner: PlayerId | null;
  /** Final adjudicated result: 'p0' | 'p1' | 'draw'. */
  result: 'p0' | 'p1' | 'draw';
  turns: number;
  totalActions: number;
  aiTimeP0AvgMs: number;
  aiTimeP1AvgMs: number;
  unitCount: Record<PlayerId, number>;
};

export type TournamentReport = {
  outcomes: MatchOutcome[];
  matches: number;
  p0Wins: number;
  p1Wins: number;
  draws: number;
  avgTurns: number;
  avgAiTimeP0Ms: number;
  avgAiTimeP1Ms: number;
  /** Sparkline: '.' = p0 win, ',' = p1 win, '-' = draw. */
  sparkline: string;
};

// ─────────────────────────── Adjudication ────────────────────────────────────

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

function adjudicate(result: RunMatchResult): 'p0' | 'p1' | 'draw' {
  if (result.winner === 0) return 'p0';
  if (result.winner === 1) return 'p1';
  // No winner -> turn cap. Tiebreak on HQ count, then unit cost.
  const hq0 = hqOwnedBy(result.finalState, 0);
  const hq1 = hqOwnedBy(result.finalState, 1);
  if (hq0 !== hq1) return hq0 > hq1 ? 'p0' : 'p1';
  const c0 = totalUnitCost(result.finalState, 0);
  const c1 = totalUnitCost(result.finalState, 1);
  if (Math.abs(c0 - c1) > 1) return c0 > c1 ? 'p0' : 'p1';
  return 'draw';
}

// ─────────────────────────── Runner ──────────────────────────────────────────

export type TournamentOptions = {
  p0: AISpec;
  p1: AISpec;
  /** Map name or 'all' to rotate over every shipped map. */
  map: string;
  matches: number;
  /** First seed; subsequent matches use seed+1, seed+2, .... Defaults to 1. */
  startSeed?: number;
  /** Hard cap per match. Defaults to 200. */
  maxTurns?: number;
  /** Directory to write match jsonl logs to. */
  logDir: string;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(SRC_ROOT, '..');

async function readMapJson(mapName: string): Promise<unknown> {
  const file = path.join(SRC_ROOT, 'data', 'maps', `${mapName}.json`);
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text);
}

async function shippedMapNames(): Promise<string[]> {
  const dir = path.join(SRC_ROOT, 'data', 'maps');
  const entries = await fs.readdir(dir);
  return entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export async function runTournament(
  opts: TournamentOptions,
): Promise<TournamentReport> {
  const startSeed = opts.startSeed ?? 1;
  const maxTurns = opts.maxTurns ?? 200;
  const maps = opts.map === 'all' ? await shippedMapNames() : [opts.map];

  await fs.mkdir(opts.logDir, { recursive: true });

  const outcomes: MatchOutcome[] = [];
  for (let i = 0; i < opts.matches; i++) {
    const map = maps[i % maps.length]!;
    const seed = startSeed + i;
    const mapJson = await readMapJson(map);
    const logPath = path.join(opts.logDir, `match-${String(i + 1).padStart(3, '0')}.jsonl`);
    const result = await runMatch({
      mapName: map,
      maxTurns,
      seed,
      p0: opts.p0,
      p1: opts.p1,
      mapJson,
      writeLog: true,
      logDir: opts.logDir,
    });
    // runMatch writes its own log; rename to the deterministic per-match
    // filename so downstream tooling can index by match number.
    if (result.logPath) {
      try {
        await fs.rename(result.logPath, logPath);
      } catch {
        // Non-fatal — leave the original log file.
      }
    }

    const verdict = adjudicate(result);
    const p0Turns = result.timings.filter((t) => t.player === 0);
    const p1Turns = result.timings.filter((t) => t.player === 1);
    const avg = (xs: typeof result.timings): number =>
      xs.length === 0 ? 0 : xs.reduce((s, t) => s + t.aiElapsedMs, 0) / xs.length;

    outcomes.push({
      seed,
      map,
      rawWinner: result.winner,
      result: verdict,
      turns: result.turns,
      totalActions: result.actions.length,
      aiTimeP0AvgMs: avg(p0Turns),
      aiTimeP1AvgMs: avg(p1Turns),
      unitCount: result.unitCount,
    });
  }

  const p0Wins = outcomes.filter((o) => o.result === 'p0').length;
  const p1Wins = outcomes.filter((o) => o.result === 'p1').length;
  const draws = outcomes.filter((o) => o.result === 'draw').length;
  const avgTurns =
    outcomes.reduce((s, o) => s + o.turns, 0) / Math.max(1, outcomes.length);
  const avgAiTimeP0Ms =
    outcomes.reduce((s, o) => s + o.aiTimeP0AvgMs, 0) /
    Math.max(1, outcomes.length);
  const avgAiTimeP1Ms =
    outcomes.reduce((s, o) => s + o.aiTimeP1AvgMs, 0) /
    Math.max(1, outcomes.length);

  const sparkline = outcomes
    .map((o) => (o.result === 'p0' ? '.' : o.result === 'p1' ? ',' : '-'))
    .join('');

  return {
    outcomes,
    matches: outcomes.length,
    p0Wins,
    p1Wins,
    draws,
    avgTurns,
    avgAiTimeP0Ms,
    avgAiTimeP1Ms,
    sparkline,
  };
}

// ─────────────────────────── CLI ─────────────────────────────────────────────

type ParsedArgs = {
  p0: AIName;
  p1: AIName;
  p0WeightsPath?: string;
  p1WeightsPath?: string;
  map: string;
  matches: number;
  startSeed: number;
  maxTurns: number;
  logDir?: string;
  quiet: boolean;
};

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const out: ParsedArgs = {
    p0: 'utility',
    p1: 'random',
    map: 'duel',
    matches: 10,
    startSeed: 1,
    maxTurns: 200,
    quiet: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--p0') {
      const v = argv[++i];
      if (!v || !isAIName(v)) throw new Error(`--p0 must be one of ${AI_NAMES.join(', ')}`);
      out.p0 = v;
    } else if (a === '--p1') {
      const v = argv[++i];
      if (!v || !isAIName(v)) throw new Error(`--p1 must be one of ${AI_NAMES.join(', ')}`);
      out.p1 = v;
    } else if (a === '--p0-weights') {
      const v = argv[++i];
      if (!v) throw new Error('--p0-weights requires a path');
      out.p0WeightsPath = v;
    } else if (a === '--p1-weights') {
      const v = argv[++i];
      if (!v) throw new Error('--p1-weights requires a path');
      out.p1WeightsPath = v;
    } else if (a === '--map') {
      const v = argv[++i];
      if (!v) throw new Error('--map requires a value');
      out.map = v;
    } else if (a === '--matches') {
      const v = argv[++i];
      if (!v) throw new Error('--matches requires a value');
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad --matches: ${v}`);
      out.matches = n;
    } else if (a === '--seed') {
      const v = argv[++i];
      if (!v) throw new Error('--seed requires a value');
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n)) throw new Error(`bad --seed: ${v}`);
      out.startSeed = n;
    } else if (a === '--max-turns') {
      const v = argv[++i];
      if (!v) throw new Error('--max-turns requires a value');
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad --max-turns: ${v}`);
      out.maxTurns = n;
    } else if (a === '--log-dir') {
      const v = argv[++i];
      if (!v) throw new Error('--log-dir requires a path');
      out.logDir = v;
    } else if (a === '--verbose') {
      out.quiet = false;
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
      'Usage: tsx src/cli/tournament.ts [options]',
      '',
      '  --p0 <name>           AI for player 0 (default: utility)',
      '  --p1 <name>           AI for player 1 (default: random)',
      '  --p0-weights <path>   utility weights JSON for p0',
      '  --p1-weights <path>   utility weights JSON for p1',
      '  --map <name|all>      map name or "all" (default: duel)',
      '  --matches <N>         number of matches (default: 10)',
      '  --seed <N>            starting seed (default: 1)',
      '  --max-turns <N>       turn cap per match (default: 200)',
      '  --log-dir <path>      override the per-tournament log directory',
      '  --verbose             leave engine/match logs on',
      '  --help, -h            show this help',
    ].join('\n'),
  );
}

function formatTable(report: TournamentReport): string {
  const lines: string[] = [];
  lines.push('─── per-match ─────────────────────────────────────────────');
  lines.push(' #  map         seed  result   turns  p0Δms  p1Δms');
  for (let i = 0; i < report.outcomes.length; i++) {
    const o = report.outcomes[i]!;
    const idx = String(i + 1).padStart(2, ' ');
    const map = o.map.padEnd(11, ' ');
    const seed = String(o.seed).padStart(4, ' ');
    const verdict = o.result.padEnd(8, ' ');
    const turns = String(o.turns).padStart(5, ' ');
    const p0 = o.aiTimeP0AvgMs.toFixed(1).padStart(6, ' ');
    const p1 = o.aiTimeP1AvgMs.toFixed(1).padStart(6, ' ');
    lines.push(` ${idx} ${map} ${seed}  ${verdict} ${turns}  ${p0} ${p1}`);
  }
  lines.push('─── summary ───────────────────────────────────────────────');
  lines.push(
    ` matches: ${report.matches}   p0: ${report.p0Wins}   p1: ${report.p1Wins}   draws: ${report.draws}`,
  );
  lines.push(
    ` avg turns: ${report.avgTurns.toFixed(1)}   ` +
      `avg AI turn p0: ${report.avgAiTimeP0Ms.toFixed(1)}ms   ` +
      `avg AI turn p1: ${report.avgAiTimeP1Ms.toFixed(1)}ms`,
  );
  lines.push(` sparkline: ${report.sparkline}   (. = p0  , = p1  - = draw)`);
  lines.push('───────────────────────────────────────────────────────────');
  return lines.join('\n');
}

async function loadWeights(p?: string): Promise<AIWeights | undefined> {
  if (!p) return undefined;
  const text = await fs.readFile(p, 'utf8');
  return loadAIWeights(JSON.parse(text));
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv);
  if (args.quiet) {
    setLogEnabled('engine', false);
    setLogEnabled('match', false);
    setLogEnabled('ai', false);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir =
    args.logDir ?? path.join(PROJECT_ROOT, 'logs', `tournament-${ts}`);

  const p0Weights = await loadWeights(args.p0WeightsPath);
  const p1Weights = await loadWeights(args.p1WeightsPath);

  console.log(
    `[tournament] p0=${args.p0} p1=${args.p1} map=${args.map} matches=${args.matches} startSeed=${args.startSeed}`,
  );

  const report = await runTournament({
    p0: { name: args.p0, ...(p0Weights ? { weights: p0Weights } : {}) },
    p1: { name: args.p1, ...(p1Weights ? { weights: p1Weights } : {}) },
    map: args.map,
    matches: args.matches,
    startSeed: args.startSeed,
    maxTurns: args.maxTurns,
    logDir,
  });

  console.log(formatTable(report));
  console.log(`logs written to: ${logDir}`);
}

const isEntry =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntry) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[tournament] error: ${msg}`);
    process.exit(1);
  });
}
