// Probe gate — every persona must beat every scripted probe.
//
//   npx tsx scripts/probe-gate.ts
//   npx tsx scripts/probe-gate.ts --matches 20 --maps duel,canyon --bar 0.8
//   npx tsx scripts/probe-gate.ts --json
//
// Runs the full (persona × probe) matrix. Each cell plays `--matches` games
// per map with seeds 1..N, side-swapped by seed parity (odd seeds put the
// persona on p0, even seeds on p1) so a cell can't be won by turn-order
// advantage alone. Prints a win-rate matrix and exits 1 if any cell is below
// the bar.
//
// This is the measurement self-play cannot make: a round-robin only sees
// flaws that DIFFER between personas, whereas a probe is a fixed degenerate
// strategy that exposes blind spots the whole generation shares. See
// `src/engine/ai/probes.ts`.

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMatch } from '../src/cli/run-match';
import { PERSONA_NAMES } from '../src/engine/ai/personas';
import { PROBE_NAMES } from '../src/engine/ai/probes';
import { setLogEnabled } from '../src/engine/core/logger';

const DEFAULT_MAPS: ReadonlyArray<string> = ['duel', 'crossroads', 'canyon'];

export type ProbeGateArgs = {
  /** Matches per (persona, probe, map) cell — seeds 1..matches. */
  matches: number;
  maps: string[];
  /** Minimum win rate (0..1) a persona must hit against every probe. */
  bar: number;
  maxTurns: number;
  json: boolean;
};

export type CellResult = {
  persona: string;
  probe: string;
  wins: number;
  losses: number;
  draws: number;
  total: number;
  winRate: number;
  /** Per-map breakdown, keyed by map name. */
  byMap: Record<string, { wins: number; total: number }>;
};

export type ProbeGateReport = {
  personas: string[];
  probes: string[];
  maps: string[];
  matchesPerCellPerMap: number;
  maxTurns: number;
  bar: number;
  cells: CellResult[];
  failures: Array<{ persona: string; probe: string; winRate: number }>;
  elapsedMs: number;
};

// ─────────────────────────── Argv parsing ────────────────────────────────────

export function parseArgs(argv: ReadonlyArray<string>): ProbeGateArgs {
  const out: ProbeGateArgs = {
    matches: 10,
    maps: [...DEFAULT_MAPS],
    bar: 0.7,
    maxTurns: 120,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--matches') {
      const v = argv[++i];
      if (!v) throw new Error('--matches requires a value');
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad --matches: ${v}`);
      out.matches = n;
    } else if (a === '--maps') {
      const v = argv[++i];
      if (!v) throw new Error('--maps requires a value');
      const list = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      if (list.length === 0) throw new Error('--maps requires at least one map');
      out.maps = list;
    } else if (a === '--bar') {
      const v = argv[++i];
      if (!v) throw new Error('--bar requires a value');
      const n = Number.parseFloat(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`bad --bar: ${v}`);
      out.bar = n;
    } else if (a === '--max-turns') {
      const v = argv[++i];
      if (!v) throw new Error('--max-turns requires a value');
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad --max-turns: ${v}`);
      out.maxTurns = n;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${String(a)}`);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(
    [
      'Usage: tsx scripts/probe-gate.ts [options]',
      '',
      '  --matches <N>     matches per persona×probe×map cell (default: 10)',
      `  --maps <a,b,c>    maps to run (default: ${DEFAULT_MAPS.join(',')})`,
      '  --bar <0..1>      minimum win rate per cell (default: 0.70)',
      '  --max-turns <N>   per-match turn cap (default: 120)',
      '  --json            emit the report as JSON instead of a table',
      '  --help, -h        show this help',
      '',
      `  personas: ${PERSONA_NAMES.join(', ')}`,
      `  probes:   ${PROBE_NAMES.join(', ')}`,
    ].join('\n'),
  );
}

// ─────────────────────────── Runner ──────────────────────────────────────────

export async function runProbeGate(args: ProbeGateArgs): Promise<ProbeGateReport> {
  const started = Date.now();
  const personas = [...PERSONA_NAMES];
  const probes = [...PROBE_NAMES];
  const cells: CellResult[] = [];

  for (const persona of personas) {
    for (const probe of probes) {
      const cell: CellResult = {
        persona,
        probe,
        wins: 0,
        losses: 0,
        draws: 0,
        total: 0,
        winRate: 0,
        byMap: {},
      };
      for (const map of args.maps) {
        const perMap = { wins: 0, total: 0 };
        for (let seed = 1; seed <= args.matches; seed++) {
          // Odd seeds: persona on p0. Even seeds: persona on p1.
          const personaSide = seed % 2 === 1 ? 0 : 1;
          const result = await runMatch({
            mapName: map,
            maxTurns: args.maxTurns,
            seed,
            p0: { name: personaSide === 0 ? persona : probe },
            p1: { name: personaSide === 0 ? probe : persona },
            writeLog: false,
          });
          cell.total += 1;
          perMap.total += 1;
          if (result.winner === personaSide) {
            cell.wins += 1;
            perMap.wins += 1;
          } else if (result.winner === null) {
            cell.draws += 1;
          } else {
            cell.losses += 1;
          }
        }
        cell.byMap[map] = perMap;
      }
      cell.winRate = cell.total > 0 ? cell.wins / cell.total : 0;
      cells.push(cell);
    }
  }

  const failures = cells
    .filter((c) => c.winRate < args.bar)
    .map((c) => ({ persona: c.persona, probe: c.probe, winRate: c.winRate }));

  return {
    personas,
    probes,
    maps: [...args.maps],
    matchesPerCellPerMap: args.matches,
    maxTurns: args.maxTurns,
    bar: args.bar,
    cells,
    failures,
    elapsedMs: Date.now() - started,
  };
}

// ─────────────────────────── Report ──────────────────────────────────────────

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function formatMatrix(report: ProbeGateReport): string {
  const lines: string[] = [];
  const nameW = Math.max(12, ...report.personas.map((p) => p.length));
  const colW = Math.max(12, ...report.probes.map((p) => p.length + 2));

  lines.push(
    `── probe gate — maps: ${report.maps.join(',')} · ${report.matchesPerCellPerMap} matches/cell/map ` +
      `· maxTurns ${report.maxTurns} · bar ${pct(report.bar)} ──`,
  );
  lines.push('');
  lines.push(
    'persona'.padEnd(nameW) + report.probes.map((p) => p.padStart(colW)).join(''),
  );
  for (const persona of report.personas) {
    let row = persona.padEnd(nameW);
    for (const probe of report.probes) {
      const cell = report.cells.find((c) => c.persona === persona && c.probe === probe);
      const txt = cell
        ? `${pct(cell.winRate)}${cell.winRate < report.bar ? '!' : ' '}`
        : '-';
      row += txt.padStart(colW);
    }
    lines.push(row);
  }
  lines.push('');
  lines.push('(win% counts only outright wins — draws and turn-cap stalemates count against)');
  lines.push('');

  // Raw W/L/D per cell, so a 50% is legible as 5-5-0 vs 0-0-10.
  lines.push('── W-L-D per cell ──');
  for (const c of report.cells) {
    lines.push(
      `  ${c.persona.padEnd(nameW)} vs ${c.probe.padEnd(colW)} ` +
        `${c.wins}-${c.losses}-${c.draws}  (${pct(c.winRate)})`,
    );
  }
  lines.push('');

  if (report.failures.length === 0) {
    lines.push(`PASS — every persona clears ${pct(report.bar)} against every probe.`);
  } else {
    lines.push(`FAIL — ${report.failures.length} cell(s) below the ${pct(report.bar)} bar:`);
    for (const f of report.failures) {
      lines.push(`  ${f.persona} vs ${f.probe}: ${pct(f.winRate)}`);
    }
  }
  lines.push(`elapsed: ${(report.elapsedMs / 1000).toFixed(1)}s`);
  return lines.join('\n');
}

// ─────────────────────────── Entry ───────────────────────────────────────────

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv);
  setLogEnabled('engine', false);
  setLogEnabled('match', false);
  setLogEnabled('ai', false);

  const report = await runProbeGate(args);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatMatrix(report));
  }
  if (report.failures.length > 0) process.exit(1);
}

const isEntry =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntry) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[probe-gate] error: ${msg}`);
    process.exit(1);
  });
}
