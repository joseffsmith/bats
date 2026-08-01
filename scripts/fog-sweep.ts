// Fog acceptance sweep — does the duel-tuned fog bar hold on every map?
//
//   npx tsx scripts/fog-sweep.ts
//   npx tsx scripts/fog-sweep.ts --maps duel,canyon --json
//   npx tsx scripts/fog-sweep.ts --verify-seeds
//
// Answers the open question left in QUESTIONS.md ("Phantom-threat sensitivity"
// / "Aggressive AI numbers on non-duel maps"): the fog acceptance gate in
// `tests/fog-acceptance.test.ts` is tuned and pinned on `duel` only, so we do
// not know whether `PHANTOM_THREAT_PER_HIDDEN_TILE = 2` survives the other
// five maps. This script measures; it changes nothing.
//
// ── Why one match per cell, not ten seeds ────────────────────────────────────
//
// The utility family (`tier1`/`tier2`/`tier3` and every persona, fog on or
// off) NEVER draws from `ctx.rng` — only `random` and the scripted probes do.
// `runMatch` derives per-player RNGs from `seed`, but for a utility-vs-utility
// pairing nothing consumes them, so all seeds replay the identical action log.
// Verified empirically, and re-verifiable here with `--verify-seeds`.
//
// The consequence matters for reading the numbers: the existing
// `fog-acceptance.test.ts` "≥7/10 over seeds 1..10" is ten replays of ONE
// match, so it can only ever score 10/10 or 0/10. The real variation axes are
// MAP, MATCHUP and SIDE — which is exactly what this sweep enumerates, one
// match per (map × matchup × side × fog) cell.
//
// ── The matrix ───────────────────────────────────────────────────────────────
//
// Mirrors the matchup structure of `tests/fog-acceptance.test.ts` (utility
// tiers with `{ fog: true }` on both sides) and extends it two ways:
//
//   (a) ORDERING — each ladder pair is played fog-off and fog-on. If the
//       stronger tier leads without fog and trails with it, fog flipped the
//       matchup ordering on that map.
//   (b) SIDE BALANCE — each pair is played with the stronger AI on p0 and
//       again on p1, so a fog-on result cannot be an artifact of turn order.
//       The duel test only ever runs tier3 on p0.
//
// Personas (`--personas`) add the 4-persona round-robin pairs on top; off by
// default because `highlands` and the two sea maps make that expensive.

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMatch } from '../src/cli/run-match';
import { UNITS } from '../src/engine/data';
import { PERSONA_NAMES } from '../src/engine/ai/personas';
import { setLogEnabled } from '../src/engine/core/logger';
import type { GameState, PlayerId } from '../src/engine/core/types';

/** Every shipped multiplayer map (campaign maps `c1..c5` are excluded). */
const DEFAULT_MAPS: ReadonlyArray<string> = [
  'duel',
  'crossroads',
  'canyon',
  'highlands',
  'armada',
  'island_hop',
];

/**
 * Utility-ladder pairs, written [expected-stronger, expected-weaker]. The
 * first entry is the pairing `tests/fog-acceptance.test.ts` pins on duel.
 */
const LADDER_MATCHUPS: ReadonlyArray<readonly [string, string]> = [
  ['tier3', 'tier1'],
  ['tier3', 'tier2'],
  ['tier2', 'tier1'],
];

/**
 * The bar `tests/fog-acceptance.test.ts` pins: tier3 must take ≥7 of 10 under
 * fog. With inert seeds that is a per-cell win requirement; expressed as a
 * rate so the side-balanced 2-match cells can be judged against the same
 * number.
 */
const ACCEPTANCE_BAR = 0.7;

// ─────────────────────────── Adjudication ────────────────────────────────────
//
// Byte-identical to `tests/fog-acceptance.test.ts` and
// `tests/ai-tier3-vs-tier1.test.ts` so the sweep and the gate agree on what a
// win is: raw rout/HQ-capture, else more HQ tiles, else higher total unit cost.

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

export function adjudicate(
  state: GameState,
  rawWinner: PlayerId | null,
): PlayerId | 'draw' {
  if (rawWinner !== null) return rawWinner;
  const hq0 = hqOwnedBy(state, 0);
  const hq1 = hqOwnedBy(state, 1);
  if (hq0 !== hq1) return hq0 > hq1 ? 0 : 1;
  const c0 = totalUnitCost(state, 0);
  const c1 = totalUnitCost(state, 1);
  if (Math.abs(c0 - c1) > 1) return c0 > c1 ? 0 : 1;
  return 'draw';
}

// ─────────────────────────── Types ───────────────────────────────────────────

export type FogSweepArgs = {
  maps: string[];
  /** Include the persona round-robin pairs alongside the utility ladder. */
  personas: boolean;
  maxTurns: number;
  /** Seed handed to `runMatch`. Inert for utility pairings — see header. */
  seed: number;
  json: boolean;
  /** Run the seed-inertness check instead of the sweep. */
  verifySeeds: boolean;
};

/** One played match. `strongSide` is which player slot the stronger AI took. */
export type MatchCell = {
  map: string;
  strong: string;
  weak: string;
  fog: boolean;
  strongSide: PlayerId;
  /** 'strong' | 'weak' | 'draw' — outcome from the matchup's point of view. */
  outcome: 'strong' | 'weak' | 'draw';
  turns: number;
  /** True when the match ran out the clock instead of resolving. */
  cappedOut: boolean;
  elapsedMs: number;
};

/** A matchup on one map, both sides played, under one fog condition. */
export type MatchupResult = {
  map: string;
  strong: string;
  weak: string;
  fog: boolean;
  /** Matches the stronger AI won, out of `total` (one per side). */
  strongWins: number;
  total: number;
  cells: MatchCell[];
};

export type MapVerdict = {
  map: string;
  /**
   * Question (a): matchups whose ordering inverted between fog-off and fog-on.
   * Diagnostic — no acceptance test pins the tier2 rungs, so a flip here is a
   * finding to report, NOT a threshold failure.
   */
  flips: Array<{ strong: string; weak: string; offWins: number; onWins: number }>;
  /** Question (b): fog-on cells for the pinned tier3-vs-tier1 pair. */
  pinnedPairWinRate: number;
  /** Same pair with fog OFF — the control. Without it a failure is unreadable. */
  pinnedFogOffWinRate: number;
  /** The pinned test's exact shape: tier3 on p0, fog on. */
  pinnedP0Win: boolean;
  /** Diagnostic: stronger-AI win rate across every fog-on ladder cell. */
  ladderFogOnWinRate: number;
  /**
   * Absolute verdict: does the pinned pair clear the bar on this map, both
   * sides, with fog on? This is what the duel gate would assert if it were
   * generalised — but a failure here is NOT automatically fog's fault.
   */
  holds: boolean;
  /**
   * Attribution: is the fog-on result at least as good as the fog-off control?
   * If yes, whatever the absolute number, fog did not cause it and re-tuning
   * `PHANTOM_THREAT_PER_HIDDEN_TILE` cannot be the fix.
   */
  fogNeutral: boolean;
};

export type FogSweepReport = {
  maps: string[];
  matchups: Array<[string, string]>;
  maxTurns: number;
  seed: number;
  bar: number;
  results: MatchupResult[];
  verdicts: MapVerdict[];
  elapsedMs: number;
};

// ─────────────────────────── Argv parsing ────────────────────────────────────

export function parseArgs(argv: ReadonlyArray<string>): FogSweepArgs {
  const out: FogSweepArgs = {
    maps: [...DEFAULT_MAPS],
    personas: false,
    maxTurns: 200,
    seed: 1,
    json: false,
    verifySeeds: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--maps') {
      const v = argv[++i];
      if (!v) throw new Error('--maps requires a value');
      const list = v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (list.length === 0) throw new Error('--maps requires at least one map');
      out.maps = list;
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
    } else if (a === '--personas') {
      out.personas = true;
    } else if (a === '--verify-seeds') {
      out.verifySeeds = true;
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
      'Usage: tsx scripts/fog-sweep.ts [options]',
      '',
      'Measures whether the duel-tuned fog acceptance bar holds on every map.',
      'Measurement only — it never edits weights or thresholds.',
      '',
      `  --maps <a,b,c>    maps to sweep (default: ${DEFAULT_MAPS.join(',')})`,
      '  --personas        also sweep the 4-persona pairs (slow)',
      '  --max-turns <N>   per-match turn cap (default: 200, matching the gate)',
      '  --seed <N>        seed passed to runMatch (default: 1; inert for',
      '                      utility-vs-utility — see --verify-seeds)',
      '  --json            emit the report as JSON instead of tables',
      '  --verify-seeds    replay one cell across seeds 1..5 and report whether',
      '                      the action log ever differs, instead of sweeping',
      '  --help, -h        show this help',
      '',
      `  ladder pairs: ${LADDER_MATCHUPS.map(([a, b]) => `${a}>${b}`).join(', ')}`,
      `  personas:     ${PERSONA_NAMES.join(', ')}`,
    ].join('\n'),
  );
}

// ─────────────────────────── Matchup set ─────────────────────────────────────

/** Unordered persona pairs, written in `PERSONA_NAMES` order. */
function personaMatchups(): Array<[string, string]> {
  const names = [...PERSONA_NAMES];
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      pairs.push([names[i]!, names[j]!]);
    }
  }
  return pairs;
}

export function matchupsFor(args: FogSweepArgs): Array<[string, string]> {
  const ladder = LADDER_MATCHUPS.map(([a, b]) => [a, b] as [string, string]);
  return args.personas ? [...ladder, ...personaMatchups()] : ladder;
}

// ─────────────────────────── Seed-inertness check ────────────────────────────

function fnv1a(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export type SeedCheck = {
  map: string;
  fog: boolean;
  seeds: number[];
  hashes: string[];
  /** True when every seed produced a byte-identical action log. */
  inert: boolean;
};

/**
 * Replay tier3-vs-tier1 across several seeds and hash the action log each
 * time. If every hash matches, the seed consumes no randomness for this
 * pairing and a one-match-per-cell sweep loses nothing.
 */
export async function verifySeedInertness(
  map: string,
  fog: boolean,
  seeds: ReadonlyArray<number>,
  maxTurns: number,
): Promise<SeedCheck> {
  const hashes: string[] = [];
  for (const seed of seeds) {
    const r = await runMatch({
      mapName: map,
      maxTurns,
      seed,
      writeLog: false,
      p0: { name: 'tier3', fog },
      p1: { name: 'tier1', fog },
    });
    hashes.push(fnv1a(JSON.stringify(r.actions)));
  }
  return {
    map,
    fog,
    seeds: [...seeds],
    hashes,
    inert: hashes.every((h) => h === hashes[0]),
  };
}

// ─────────────────────────── Runner ──────────────────────────────────────────

async function playCell(
  map: string,
  strong: string,
  weak: string,
  fog: boolean,
  strongSide: PlayerId,
  args: FogSweepArgs,
): Promise<MatchCell> {
  const t0 = Date.now();
  const result = await runMatch({
    mapName: map,
    maxTurns: args.maxTurns,
    seed: args.seed,
    writeLog: false,
    p0: { name: strongSide === 0 ? strong : weak, fog },
    p1: { name: strongSide === 0 ? weak : strong, fog },
  });
  const verdict = adjudicate(result.finalState, result.winner);
  const outcome: MatchCell['outcome'] =
    verdict === 'draw' ? 'draw' : verdict === strongSide ? 'strong' : 'weak';
  return {
    map,
    strong,
    weak,
    fog,
    strongSide,
    outcome,
    turns: result.turns,
    cappedOut: result.winner === null,
    elapsedMs: Date.now() - t0,
  };
}

export async function runFogSweep(args: FogSweepArgs): Promise<FogSweepReport> {
  const started = Date.now();
  const matchups = matchupsFor(args);
  const results: MatchupResult[] = [];

  for (const map of args.maps) {
    for (const [strong, weak] of matchups) {
      for (const fog of [false, true]) {
        const cells: MatchCell[] = [];
        for (const strongSide of [0, 1] as PlayerId[]) {
          cells.push(await playCell(map, strong, weak, fog, strongSide, args));
        }
        results.push({
          map,
          strong,
          weak,
          fog,
          strongWins: cells.filter((c) => c.outcome === 'strong').length,
          total: cells.length,
          cells,
        });
      }
    }
  }

  return {
    maps: [...args.maps],
    matchups,
    maxTurns: args.maxTurns,
    seed: args.seed,
    bar: ACCEPTANCE_BAR,
    results,
    verdicts: verdictsFor(results, args.maps),
    elapsedMs: Date.now() - started,
  };
}

// ─────────────────────────── Verdicts ────────────────────────────────────────

/** -1 / 0 / +1 — who led the matchup, from `strongWins` out of two sides. */
function lead(strongWins: number, total: number): number {
  const margin = strongWins - (total - strongWins);
  return Math.sign(margin);
}

export function verdictsFor(
  results: ReadonlyArray<MatchupResult>,
  maps: ReadonlyArray<string>,
): MapVerdict[] {
  const verdicts: MapVerdict[] = [];
  for (const map of maps) {
    const onMap = results.filter((r) => r.map === map);
    const flips: MapVerdict['flips'] = [];
    for (const off of onMap.filter((r) => !r.fog)) {
      const on = onMap.find(
        (r) => r.fog && r.strong === off.strong && r.weak === off.weak,
      );
      if (!on) continue;
      const offLead = lead(off.strongWins, off.total);
      const onLead = lead(on.strongWins, on.total);
      // A flip is a strict inversion of who leads, not a drop to level.
      if (offLead !== 0 && onLead !== 0 && offLead !== onLead) {
        flips.push({
          strong: off.strong,
          weak: off.weak,
          offWins: off.strongWins,
          onWins: on.strongWins,
        });
      }
    }

    const pinned = onMap.find(
      (r) => r.fog && r.strong === 'tier3' && r.weak === 'tier1',
    );
    const pinnedOff = onMap.find(
      (r) => !r.fog && r.strong === 'tier3' && r.weak === 'tier1',
    );
    const pinnedPairWinRate = pinned ? pinned.strongWins / pinned.total : 0;
    const pinnedFogOffWinRate = pinnedOff
      ? pinnedOff.strongWins / pinnedOff.total
      : 0;
    const pinnedP0Win =
      pinned?.cells.find((c) => c.strongSide === 0)?.outcome === 'strong';

    const ladderNames = new Set(LADDER_MATCHUPS.map(([a, b]) => `${a}>${b}`));
    const ladderOn = onMap.filter(
      (r) => r.fog && ladderNames.has(`${r.strong}>${r.weak}`),
    );
    const ladderWins = ladderOn.reduce((s, r) => s + r.strongWins, 0);
    const ladderTotal = ladderOn.reduce((s, r) => s + r.total, 0);
    const ladderFogOnWinRate = ladderTotal > 0 ? ladderWins / ladderTotal : 0;

    verdicts.push({
      map,
      flips,
      pinnedPairWinRate,
      pinnedFogOffWinRate,
      pinnedP0Win,
      ladderFogOnWinRate,
      // Deliberately NOT gated on `flips` or `ladderFogOnWinRate`: the only
      // threshold the repo pins under fog is tier3-vs-tier1. Folding the
      // unpinned tier2 rungs in here would report the tuned baseline map as a
      // failure of its own gate.
      holds: pinnedP0Win && pinnedPairWinRate >= ACCEPTANCE_BAR,
      fogNeutral: pinnedPairWinRate >= pinnedFogOffWinRate,
    });
  }
  return verdicts;
}

// ─────────────────────────── Report ──────────────────────────────────────────

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function cellGlyph(cells: ReadonlyArray<MatchCell>, side: PlayerId): string {
  const c = cells.find((x) => x.strongSide === side);
  if (!c) return '-';
  const letter = c.outcome === 'strong' ? 'W' : c.outcome === 'weak' ? 'L' : 'D';
  return c.cappedOut ? `${letter}*` : letter;
}

export function formatReport(report: FogSweepReport): string {
  const lines: string[] = [];
  lines.push(
    `── fog sweep — ${report.maps.length} maps × ${report.matchups.length} matchups ` +
      `× 2 sides × {fog off, fog on} · maxTurns ${report.maxTurns} · seed ${report.seed} ──`,
  );
  lines.push('');
  lines.push(
    'W/L/D is from the stronger AI\'s point of view. `p0`/`p1` is the slot the',
  );
  lines.push('stronger AI took. `*` marks a match that hit the turn cap.');
  lines.push('');

  for (const map of report.maps) {
    const onMap = report.results.filter((r) => r.map === map);
    if (onMap.length === 0) continue;
    lines.push(`── ${map} ──`);
    lines.push(
      '  matchup'.padEnd(30) +
        'fog-off'.padStart(18) +
        'fog-on'.padStart(18) +
        '   verdict',
    );
    const pairs = report.matchups;
    for (const [strong, weak] of pairs) {
      const off = onMap.find((r) => !r.fog && r.strong === strong && r.weak === weak);
      const on = onMap.find((r) => r.fog && r.strong === strong && r.weak === weak);
      if (!off || !on) continue;
      const offTxt = `${cellGlyph(off.cells, 0)}/${cellGlyph(off.cells, 1)} (${off.strongWins}/${off.total})`;
      const onTxt = `${cellGlyph(on.cells, 0)}/${cellGlyph(on.cells, 1)} (${on.strongWins}/${on.total})`;
      const flipped =
        lead(off.strongWins, off.total) !== 0 &&
        lead(on.strongWins, on.total) !== 0 &&
        lead(off.strongWins, off.total) !== lead(on.strongWins, on.total);
      const softened =
        !flipped && on.strongWins < off.strongWins ? 'narrowed' : flipped ? '' : 'stable';
      lines.push(
        `  ${strong} vs ${weak}`.padEnd(30) +
          offTxt.padStart(18) +
          onTxt.padStart(18) +
          `   ${flipped ? 'FLIP' : softened}`,
      );
    }
    const v = report.verdicts.find((x) => x.map === map);
    if (v) {
      lines.push(
        `  → pinned pair (tier3 vs tier1): fog-off ${pct(v.pinnedFogOffWinRate)} → ` +
          `fog-on ${pct(v.pinnedPairWinRate)} · p0-only ${v.pinnedP0Win ? 'WIN' : 'LOSS'} · ` +
          `bar ${v.holds ? 'HOLDS' : 'NOT MET'} · fog ${v.fogNeutral ? 'neutral-or-better' : 'REGRESSES'}` +
          `   [ladder fog-on ${pct(v.ladderFogOnWinRate)}]`,
      );
    }
    lines.push('');
  }

  // (b1) Absolute bar. A failure here may predate fog entirely — see (b2).
  const broken = report.verdicts.filter((v) => !v.holds);
  if (broken.length === 0) {
    lines.push(
      `ABSOLUTE BAR — the pinned pair clears ${pct(report.bar)} on all ${report.maps.length} maps under fog.`,
    );
  } else {
    lines.push(
      `ABSOLUTE BAR — pinned pair below ${pct(report.bar)} under fog on ${broken.length} map(s):`,
    );
    for (const v of broken) {
      const why: string[] = [];
      if (!v.pinnedP0Win) why.push('tier3-as-p0 loses');
      if (v.pinnedPairWinRate < report.bar) {
        why.push(`${pct(v.pinnedPairWinRate)} across both sides`);
      }
      why.push(`fog-off control ${pct(v.pinnedFogOffWinRate)}`);
      lines.push(`  ${v.map}: ${why.join('; ')}`);
    }
  }

  // (b2) Attribution — the question that actually decides whether to re-tune.
  lines.push('');
  const regressed = report.verdicts.filter((v) => !v.fogNeutral);
  if (regressed.length === 0) {
    lines.push(
      'FOG ATTRIBUTION — on every map the fog-on pinned pair matches or beats its\n' +
        'fog-off control, so fog causes none of the shortfalls above. They are\n' +
        'pre-existing map/side effects; PHANTOM_THREAT_PER_HIDDEN_TILE is not the lever.',
    );
  } else {
    lines.push('FOG ATTRIBUTION — fog itself degrades the pinned pair on:');
    for (const v of regressed) {
      lines.push(
        `  ${v.map}: ${pct(v.pinnedFogOffWinRate)} fog-off → ${pct(v.pinnedPairWinRate)} fog-on`,
      );
    }
  }

  // (a) ordering, reported separately — unpinned, diagnostic only.
  const flipping = report.verdicts.filter((v) => v.flips.length > 0);
  lines.push('');
  if (flipping.length === 0) {
    lines.push('ORDERING — fog inverts no matchup on any map.');
  } else {
    lines.push('ORDERING — fog inverts these matchups (unpinned; diagnostic):');
    for (const v of flipping) {
      for (const f of v.flips) {
        lines.push(
          `  ${v.map}: ${f.strong} vs ${f.weak} — ${f.offWins}/2 fog-off → ${f.onWins}/2 fog-on`,
        );
      }
    }
  }
  lines.push(`elapsed: ${(report.elapsedMs / 1000).toFixed(1)}s`);
  return lines.join('\n');
}

export function formatSeedCheck(check: SeedCheck): string {
  const lines: string[] = [];
  lines.push(
    `── seed inertness — tier3 vs tier1 on ${check.map}, fog ${check.fog ? 'on' : 'off'} ──`,
  );
  for (let i = 0; i < check.seeds.length; i++) {
    lines.push(`  seed ${String(check.seeds[i]).padStart(3)}  action-log hash ${check.hashes[i]}`);
  }
  lines.push('');
  lines.push(
    check.inert
      ? 'INERT — every seed replays the identical action log. The utility AIs never\n' +
          'draw from ctx.rng, so seed sweeps add no samples; vary map/matchup/side.'
      : 'NOT INERT — seeds diverge; a multi-seed sweep is warranted after all.',
  );
  return lines.join('\n');
}

// ─────────────────────────── Entry ───────────────────────────────────────────

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv);
  setLogEnabled('engine', false);
  setLogEnabled('match', false);
  setLogEnabled('ai', false);

  if (args.verifySeeds) {
    const map = args.maps[0] ?? 'duel';
    const check = await verifySeedInertness(map, true, [1, 2, 3, 4, 5], args.maxTurns);
    console.log(args.json ? JSON.stringify(check, null, 2) : formatSeedCheck(check));
    return;
  }

  const report = await runFogSweep(args);
  console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
}

const isEntry =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntry) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[fog-sweep] error: ${msg}`);
    process.exit(1);
  });
}
