// Persona round-robin tournament harness.
//
//   npm run round-robin -- --personas aggressor,turtle,economist,balanced \
//     --matches 50 --maps duel,crossroads,canyon
//
// For every unordered pair of personas, on every map, runs `--matches` games
// (half with persona A as p0, half as p1 — eliminating side-bias). Seeds are
// derived deterministically from (personaA, personaB, map, i) so a re-run
// reproduces the same outcome set.
//
// Output:
//   - per-match jsonl log under logs/round-robin-<ts>/<pair>-<map>-<seed>.jsonl
//   - summary.tsv (one line per match — easy to load in a spreadsheet)
//   - report.json (full structured report)
//   - readable summary table on stdout
//
// Concurrency: a Promise.all-with-concurrency-limit pool runs ~8 matches in
// parallel. Each match calls `runMatch` headlessly with `writeLog: true` and
// the per-tournament logDir.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMatch, isAIName } from './run-match';
import type { AISpec, RunMatchResult } from './run-match';
import { UNITS } from '../engine/data';
import { setLogEnabled } from '../engine/core/logger';
import type { GameState, PlayerId } from '../engine/core/types';
import { PERSONA_NAMES, PERSONAS } from '../engine/ai/personas';

// ─────────────────────────── Types ───────────────────────────────────────────

export type RoundRobinOptions = {
  /** Persona names — defaults to all loaded personas. */
  personas?: ReadonlyArray<string>;
  /** Map names — defaults to ['duel','crossroads','canyon']. */
  maps?: ReadonlyArray<string>;
  /** Matches per pair per map. Halved into side-A and side-B. Default 50. */
  matches?: number;
  /** Max turns per match. Default 200. */
  maxTurns?: number;
  /** Seed-mixing salt; lets the user re-roll without changing other knobs. */
  seedSalt?: number;
  /** Target concurrency. Default 8. */
  concurrency?: number;
  /** Log root directory. Default `logs/round-robin-<ts>`. */
  logDir?: string;
};

export type MatchRecord = {
  personaA: string;
  personaB: string;
  map: string;
  seed: number;
  /** Which side persona A played on (0 or 1). */
  sideA: PlayerId;
  /** Outcome from persona A's perspective. */
  outcome: 'A' | 'B' | 'draw';
  turns: number;
  rawWinner: PlayerId | null;
  avgAiTimeMsA: number;
  avgAiTimeMsB: number;
  /** Side-balance check: did p0 win, p1 win, or draw? */
  p0Win: boolean;
  p1Win: boolean;
};

export type PairingSummary = {
  personaA: string;
  personaB: string;
  /** Per-map sub-summary; key is map name. */
  byMap: Record<
    string,
    {
      matches: number;
      aWins: number;
      bWins: number;
      draws: number;
      avgTurns: number;
    }
  >;
  totalMatches: number;
  aWins: number;
  bWins: number;
  draws: number;
};

export type PersonaRecord = {
  persona: string;
  wins: number;
  losses: number;
  draws: number;
  /** Win rate vs each opponent (key = opponent name). */
  vs: Record<string, { matches: number; wins: number; winRate: number }>;
};

export type RoundRobinReport = {
  startedAt: string;
  finishedAt: string;
  personas: ReadonlyArray<string>;
  maps: ReadonlyArray<string>;
  matchesPerPairPerMap: number;
  matchCount: number;
  /** Per-pair summary (each unordered pair once). */
  pairings: PairingSummary[];
  /** Per-persona aggregate. */
  records: PersonaRecord[];
  /** Side-balance check across ALL matches. */
  sideBalance: { p0: number; p1: number; draws: number };
  matches: MatchRecord[];
};

// ─────────────────────────── Helpers ─────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(SRC_ROOT, '..');

async function readMapJson(mapName: string): Promise<unknown> {
  const file = path.join(SRC_ROOT, 'data', 'maps', `${mapName}.json`);
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text);
}

/**
 * FNV-1a 32-bit hash. We use it to derive a stable seed from a tuple of
 * (personaA, personaB, map, i, salt) so re-running with the same args
 * reproduces the same outcomes.
 */
function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // Avoid 0 — createRng tolerates it, but a non-zero seed is friendlier.
  return h === 0 ? 1 : h;
}

function deriveSeed(
  personaA: string,
  personaB: string,
  map: string,
  i: number,
  salt: number,
): number {
  return fnv1a32(`${personaA}|${personaB}|${map}|${i}|${salt}`);
}

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

/**
 * Tournament-style adjudication on the FINAL state.
 * - raw winner wins,
 * - else more HQ tiles owned,
 * - else higher unit cost (by margin > 1),
 * - else draw.
 */
function adjudicate(result: RunMatchResult): PlayerId | 'draw' {
  if (result.winner === 0) return 0;
  if (result.winner === 1) return 1;
  const hq0 = hqOwnedBy(result.finalState, 0);
  const hq1 = hqOwnedBy(result.finalState, 1);
  if (hq0 !== hq1) return hq0 > hq1 ? 0 : 1;
  const c0 = totalUnitCost(result.finalState, 0);
  const c1 = totalUnitCost(result.finalState, 1);
  if (Math.abs(c0 - c1) > 1) return c0 > c1 ? 0 : 1;
  return 'draw';
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, v) => s + v, 0) / xs.length;
}

// ─────────────────────────── Concurrency pool ────────────────────────────────

/**
 * Drain `tasks` with a fixed concurrency budget. Order of resolution is
 * non-deterministic; the caller orders results by tagging tasks with their
 * intended index.
 */
async function pool<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= tasks.length) return;
      const task = tasks[idx]!;
      results[idx] = await task();
    }
  }
  const workers: Promise<void>[] = [];
  const n = Math.min(concurrency, Math.max(1, tasks.length));
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ─────────────────────────── Pair enumeration ────────────────────────────────

function unorderedPairs<T>(xs: ReadonlyArray<T>): Array<[T, T]> {
  const out: Array<[T, T]> = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      out.push([xs[i]!, xs[j]!]);
    }
  }
  return out;
}

// ─────────────────────────── Runner ──────────────────────────────────────────

type TaskSpec = {
  personaA: string;
  personaB: string;
  map: string;
  seed: number;
  index: number; // match index within (pair,map) — 0..matches-1
  sideA: PlayerId; // which side persona A plays
  logName: string;
};

export async function runRoundRobin(opts: RoundRobinOptions): Promise<RoundRobinReport> {
  const personas = opts.personas && opts.personas.length > 0
    ? [...opts.personas]
    : [...PERSONA_NAMES];
  for (const p of personas) {
    if (!(p in PERSONAS)) {
      throw new Error(`unknown persona "${p}" — available: ${PERSONA_NAMES.join(', ')}`);
    }
  }
  const maps = opts.maps && opts.maps.length > 0
    ? [...opts.maps]
    : ['duel', 'crossroads', 'canyon'];
  const matchesPerPairPerMap = opts.matches ?? 50;
  const maxTurns = opts.maxTurns ?? 200;
  const seedSalt = opts.seedSalt ?? 0;
  const concurrency = opts.concurrency ?? 8;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = opts.logDir ?? path.join(PROJECT_ROOT, 'logs', `round-robin-${ts}`);
  await fs.mkdir(logDir, { recursive: true });
  // Pre-read map JSON once per map — avoid 1200 fs reads on a big tournament.
  const mapJsons: Record<string, unknown> = {};
  for (const m of maps) mapJsons[m] = await readMapJson(m);

  // Build the full task list.
  const tasks: TaskSpec[] = [];
  for (const [a, b] of unorderedPairs(personas)) {
    for (const map of maps) {
      for (let i = 0; i < matchesPerPairPerMap; i++) {
        // Half the matches with personaA as p0, half as p1.
        const sideA: PlayerId = (i < Math.floor(matchesPerPairPerMap / 2) ? 0 : 1) as PlayerId;
        const seed = deriveSeed(a, b, map, i, seedSalt);
        tasks.push({
          personaA: a,
          personaB: b,
          map,
          seed,
          index: i,
          sideA,
          logName: `${a}-vs-${b}-${map}-${String(i).padStart(3, '0')}-s${seed}.jsonl`,
        });
      }
    }
  }

  const startedAt = new Date().toISOString();
  const records: MatchRecord[] = new Array(tasks.length);

  const taskFns = tasks.map((t, idx) => async (): Promise<void> => {
    const p0: AISpec = { name: t.sideA === 0 ? t.personaA : t.personaB };
    const p1: AISpec = { name: t.sideA === 0 ? t.personaB : t.personaA };
    const result = await runMatch({
      mapName: t.map,
      maxTurns,
      seed: t.seed,
      p0,
      p1,
      mapJson: mapJsons[t.map],
      writeLog: true,
      logDir,
    });
    // Rename the auto-named log to a deterministic name.
    if (result.logPath) {
      const target = path.join(logDir, t.logName);
      try {
        await fs.rename(result.logPath, target);
      } catch {
        // non-fatal
      }
    }

    const verdict = adjudicate(result);
    let outcome: 'A' | 'B' | 'draw';
    if (verdict === 'draw') outcome = 'draw';
    else if (verdict === t.sideA) outcome = 'A';
    else outcome = 'B';

    const p0Turns = result.timings.filter((x) => x.player === 0).map((x) => x.aiElapsedMs);
    const p1Turns = result.timings.filter((x) => x.player === 1).map((x) => x.aiElapsedMs);
    const aTurns = t.sideA === 0 ? p0Turns : p1Turns;
    const bTurns = t.sideA === 0 ? p1Turns : p0Turns;

    records[idx] = {
      personaA: t.personaA,
      personaB: t.personaB,
      map: t.map,
      seed: t.seed,
      sideA: t.sideA,
      outcome,
      turns: result.turns,
      rawWinner: result.winner,
      avgAiTimeMsA: avg(aTurns),
      avgAiTimeMsB: avg(bTurns),
      p0Win: verdict === 0,
      p1Win: verdict === 1,
    };
  });

  await pool(taskFns, concurrency);
  const finishedAt = new Date().toISOString();

  // ── Per-pair summaries ─────────────────────────────────────────────────────
  const pairings: PairingSummary[] = [];
  for (const [a, b] of unorderedPairs(personas)) {
    const byMap: PairingSummary['byMap'] = {};
    let totalMatches = 0;
    let aWins = 0;
    let bWins = 0;
    let draws = 0;
    for (const map of maps) {
      const relevant = records.filter((r) => r.personaA === a && r.personaB === b && r.map === map);
      const mAWins = relevant.filter((r) => r.outcome === 'A').length;
      const mBWins = relevant.filter((r) => r.outcome === 'B').length;
      const mDraws = relevant.filter((r) => r.outcome === 'draw').length;
      const mAvgTurns = avg(relevant.map((r) => r.turns));
      byMap[map] = {
        matches: relevant.length,
        aWins: mAWins,
        bWins: mBWins,
        draws: mDraws,
        avgTurns: mAvgTurns,
      };
      totalMatches += relevant.length;
      aWins += mAWins;
      bWins += mBWins;
      draws += mDraws;
    }
    pairings.push({
      personaA: a,
      personaB: b,
      byMap,
      totalMatches,
      aWins,
      bWins,
      draws,
    });
  }

  // ── Per-persona aggregate ──────────────────────────────────────────────────
  const recordsByName: Record<string, PersonaRecord> = {};
  for (const p of personas) {
    recordsByName[p] = {
      persona: p,
      wins: 0,
      losses: 0,
      draws: 0,
      vs: {},
    };
    for (const q of personas) {
      if (q === p) continue;
      recordsByName[p].vs[q] = { matches: 0, wins: 0, winRate: 0 };
    }
  }
  for (const r of records) {
    const A = recordsByName[r.personaA]!;
    const B = recordsByName[r.personaB]!;
    A.vs[r.personaB]!.matches += 1;
    B.vs[r.personaA]!.matches += 1;
    if (r.outcome === 'A') {
      A.wins += 1;
      B.losses += 1;
      A.vs[r.personaB]!.wins += 1;
    } else if (r.outcome === 'B') {
      B.wins += 1;
      A.losses += 1;
      B.vs[r.personaA]!.wins += 1;
    } else {
      A.draws += 1;
      B.draws += 1;
    }
  }
  for (const p of personas) {
    const rec = recordsByName[p]!;
    for (const q of personas) {
      if (q === p) continue;
      const e = rec.vs[q]!;
      e.winRate = e.matches > 0 ? e.wins / e.matches : 0;
    }
  }

  const sideBalance = {
    p0: records.filter((r) => r.p0Win).length,
    p1: records.filter((r) => r.p1Win).length,
    draws: records.filter((r) => !r.p0Win && !r.p1Win).length,
  };

  const report: RoundRobinReport = {
    startedAt,
    finishedAt,
    personas,
    maps,
    matchesPerPairPerMap,
    matchCount: records.length,
    pairings,
    records: personas.map((p) => recordsByName[p]!),
    sideBalance,
    matches: records,
  };

  // ── Write summary.tsv and report.json ──────────────────────────────────────
  const tsvLines: string[] = [
    [
      'personaA',
      'personaB',
      'map',
      'seed',
      'sideA',
      'outcome',
      'turns',
      'rawWinner',
      'avgAiMsA',
      'avgAiMsB',
    ].join('\t'),
  ];
  for (const r of records) {
    tsvLines.push(
      [
        r.personaA,
        r.personaB,
        r.map,
        String(r.seed),
        String(r.sideA),
        r.outcome,
        String(r.turns),
        r.rawWinner === null ? '-' : String(r.rawWinner),
        r.avgAiTimeMsA.toFixed(2),
        r.avgAiTimeMsB.toFixed(2),
      ].join('\t'),
    );
  }
  await fs.writeFile(path.join(logDir, 'summary.tsv'), tsvLines.join('\n') + '\n', 'utf8');
  await fs.writeFile(
    path.join(logDir, 'report.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  );

  return report;
}

// ─────────────────────────── Pretty-printing ─────────────────────────────────

export function formatReport(report: RoundRobinReport): string {
  const lines: string[] = [];
  lines.push(
    `── round-robin: ${report.personas.length} personas × ${report.maps.length} maps × ${report.matchesPerPairPerMap}/pair = ${report.matchCount} matches ──`,
  );
  lines.push(`  personas: ${report.personas.join(', ')}`);
  lines.push(`  maps:     ${report.maps.join(', ')}`);
  lines.push('');

  // Records.
  lines.push('── per-persona record ──');
  lines.push('  persona       W   L   D    WR');
  for (const r of report.records) {
    const total = r.wins + r.losses + r.draws;
    const wr = total > 0 ? r.wins / total : 0;
    lines.push(
      `  ${r.persona.padEnd(13)} ${String(r.wins).padStart(3)} ${String(r.losses).padStart(3)} ${String(r.draws).padStart(3)}  ${(wr * 100).toFixed(1).padStart(4)}%`,
    );
  }
  lines.push('');

  // Pairwise matrix (rows = personaA, cols = personaB).
  lines.push('── pairing matrix (row vs col, % win for row) ──');
  const header =
    '             ' +
    report.personas.map((p) => p.slice(0, 10).padStart(11)).join(' ');
  lines.push(header);
  for (const row of report.personas) {
    const rec = report.records.find((r) => r.persona === row)!;
    const cells: string[] = [];
    for (const col of report.personas) {
      if (col === row) {
        cells.push('     -     ');
      } else {
        const v = rec.vs[col]!;
        const cell =
          v.matches > 0
            ? `${(v.winRate * 100).toFixed(0).padStart(3)}% (${v.wins}/${v.matches})`
            : '     -     ';
        cells.push(cell.padStart(11));
      }
    }
    lines.push(`${row.padEnd(13)}${cells.join(' ')}`);
  }
  lines.push('');

  // Per-pair, per-map.
  lines.push('── per-pair, per-map ──');
  lines.push('  pairing                       map        matches   A-W   B-W   D   avgTurns');
  for (const p of report.pairings) {
    for (const map of report.maps) {
      const m = p.byMap[map];
      if (!m) continue;
      lines.push(
        `  ${(p.personaA + ' vs ' + p.personaB).padEnd(28)}  ${map.padEnd(11)}   ${String(m.matches).padStart(5)}  ${String(m.aWins).padStart(4)}  ${String(m.bWins).padStart(4)}  ${String(m.draws).padStart(3)}   ${m.avgTurns.toFixed(1).padStart(6)}`,
      );
    }
  }
  lines.push('');

  // Side balance sanity check.
  const total = report.matchCount;
  const p0Pct = total > 0 ? (report.sideBalance.p0 / total) * 100 : 0;
  const p1Pct = total > 0 ? (report.sideBalance.p1 / total) * 100 : 0;
  lines.push(
    `── side balance: p0=${report.sideBalance.p0} (${p0Pct.toFixed(1)}%)  p1=${report.sideBalance.p1} (${p1Pct.toFixed(1)}%)  draws=${report.sideBalance.draws}`,
  );
  // Mark imbalance > 60/40 — could indicate a buggy map or first-move bonus.
  if (Math.abs(p0Pct - p1Pct) > 20) {
    lines.push('  ! side imbalance > 20 percentage points — check map fairness');
  }
  return lines.join('\n');
}

// ─────────────────────────── CLI entry ───────────────────────────────────────

type ParsedArgs = {
  personas: string[];
  maps: string[];
  matches: number;
  maxTurns: number;
  seedSalt: number;
  concurrency: number;
  out?: string;
  quiet: boolean;
};

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const out: ParsedArgs = {
    personas: [...PERSONA_NAMES],
    maps: ['duel', 'crossroads', 'canyon'],
    matches: 50,
    maxTurns: 200,
    seedSalt: 0,
    concurrency: 8,
    quiet: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--personas') {
      const v = argv[++i];
      if (!v) throw new Error('--personas requires a value');
      const list = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      for (const p of list) {
        if (!isAIName(p) || !(p in PERSONAS)) {
          throw new Error(
            `--personas: "${p}" is not a known persona (have: ${PERSONA_NAMES.join(', ')})`,
          );
        }
      }
      out.personas = list;
    } else if (a === '--maps') {
      const v = argv[++i];
      if (!v) throw new Error('--maps requires a value');
      out.maps = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    } else if (a === '--matches') {
      const v = argv[++i];
      if (!v) throw new Error('--matches requires a value');
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad --matches: ${v}`);
      out.matches = n;
    } else if (a === '--max-turns') {
      const v = argv[++i];
      if (!v) throw new Error('--max-turns requires a value');
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad --max-turns: ${v}`);
      out.maxTurns = n;
    } else if (a === '--seed-salt' || a === '--seed-start') {
      const v = argv[++i];
      if (!v) throw new Error('--seed-salt requires a value');
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n)) throw new Error(`bad --seed-salt: ${v}`);
      out.seedSalt = n;
    } else if (a === '--concurrency') {
      const v = argv[++i];
      if (!v) throw new Error('--concurrency requires a value');
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad --concurrency: ${v}`);
      out.concurrency = n;
    } else if (a === '--out') {
      const v = argv[++i];
      if (!v) throw new Error('--out requires a path');
      out.out = v;
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
      'Usage: tsx src/cli/round-robin.ts [options]',
      '',
      `  --personas <a,b,c>    persona names (default: all loaded)`,
      `  --maps <m1,m2,...>    map names (default: duel,crossroads,canyon)`,
      `  --matches <N>         matches per pair per map (default: 50)`,
      `  --max-turns <N>       turn cap per match (default: 200)`,
      `  --seed-salt <N>       seed-mix salt for re-rolls (default: 0)`,
      `  --concurrency <N>     parallel matches (default: 8)`,
      `  --out <path>          override the log/report directory`,
      `  --verbose             leave engine/match logs on`,
      `  --help, -h            show this help`,
      '',
      `  available personas: ${PERSONA_NAMES.join(', ')}`,
    ].join('\n'),
  );
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv);
  if (args.quiet) {
    setLogEnabled('engine', false);
    setLogEnabled('match', false);
    setLogEnabled('ai', false);
  }
  console.log(
    `[round-robin] personas=${args.personas.join(',')} maps=${args.maps.join(',')} matches/pair/map=${args.matches} concurrency=${args.concurrency}`,
  );
  const start = Date.now();
  const report = await runRoundRobin({
    personas: args.personas,
    maps: args.maps,
    matches: args.matches,
    maxTurns: args.maxTurns,
    seedSalt: args.seedSalt,
    concurrency: args.concurrency,
    ...(args.out ? { logDir: args.out } : {}),
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(formatReport(report));
  console.log(`\nelapsed: ${elapsed}s   matches: ${report.matchCount}`);
}

const isEntry =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntry) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[round-robin] error: ${msg}`);
    process.exit(1);
  });
}
