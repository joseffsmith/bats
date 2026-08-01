// Replay degeneracy miner.
//
// Scans match logs (local JSONL dirs or the deployed site's replay API),
// re-folds every action stream through the reducer, and reports positions the
// AI should never have allowed to happen. This is the "what went wrong" half of
// the tuning loop: round-robin win rates say *that* a persona is weak, the
// miner says *how* (a capturer nobody contested, a unit that paced between two
// tiles for 20 turns, a game that timed out with a 3:1 material lead).
//
//   npx tsx scripts/mine-replays.ts --dir logs/rr-iter8-post
//   npx tsx scripts/mine-replays.ts --dir logs --stall-turns 8 --json
//   npx tsx scripts/mine-replays.ts --remote [--base https://bats.joseffsmith.uk]
//
// Scanning is replay-bound (every action is re-reduced, every state kept), so a
// whole `logs/` tree of long matches takes minutes — `--limit N` caps how many
// files a run touches when you just want a sample.
//
// Flags (each an exported pure function over { file, parsed, states } so tests
// and other scripts can call them directly):
//
//   uncontestedCapture  a tile flipped owner while the losing side had a unit
//                       in striking distance that never swung at the capturer
//   stalledUnit         a unit parked on one tile / bouncing between two for
//                       >= --stall-turns of its own turns
//   turnCapHit          no summary, no winner, or turns >= header.maxTurns
//   heldLeadNoWin       >= --lead-pct material lead held for >= --lead-turns
//                       turns without converting it into a win
//
// Unparseable / unreplayable logs are counted and listed, never fatal — old
// logs reference maps or action shapes the engine has since changed.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Coord, GameState, PlayerId, UnitId, UnitType } from '../src/engine/core/types';
import { manhattan, tileAt } from '../src/engine/core/types';
import { setLogEnabled } from '../src/engine/core/logger';
import { UNITS } from '../src/engine/data';
import { loadMap } from '../src/engine/data/loader';
import { enableFogMemory } from '../src/engine/systems/memory';
import type { ParsedLog } from '../src/engine/replay';
import { parseLog, replay } from '../src/engine/replay';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const MAPS_DIR = path.join(REPO_ROOT, 'src', 'data', 'maps');

const DEFAULT_BASE = 'https://bats.joseffsmith.uk';

// ───────────────────────────── options + shapes ──────────────────────────────

export type MineOptions = {
  /** stalledUnit: minimum consecutive own-turns on <= 2 tiles. */
  stallTurns: number;
  /** heldLeadNoWin: minimum lead percentage. */
  leadPct: number;
  /** heldLeadNoWin: minimum consecutive turns holding that lead. */
  leadTurns: number;
  /** turnCapHit: fallback when a header omits `maxTurns`. */
  defaultMaxTurns: number;
};

export const DEFAULT_OPTIONS: MineOptions = {
  stallTurns: 6,
  leadPct: 40,
  leadTurns: 20,
  defaultMaxTurns: 120,
};

/**
 * One replayed match: the parsed log plus the per-action state sequence from
 * `replay()`. `states[0]` is the initial state and `states[i + 1]` is the state
 * after `parsed.actions[i]` — so action index `i` is exactly the transition
 * `states[i] -> states[i + 1]`. Every detector relies on that alignment.
 */
export type MinedLog = {
  file: string;
  parsed: ParsedLog;
  states: readonly GameState[];
};

export type UncontestedCaptureHit = {
  file: string;
  tile: Coord;
  terrain: string;
  /** The player who lost the tile. */
  victim: PlayerId;
  capturerId: UnitId;
  capturerType: string;
  /** Victim units that were in reach for the whole window and never attacked. */
  idleDefenderIds: UnitId[];
  fromTurn: number;
  toTurn: number;
};

export type StalledUnitHit = {
  file: string;
  unitId: UnitId;
  unitType: string;
  owner: PlayerId;
  /** The one or two tiles the unit confined itself to. */
  tiles: Coord[];
  fromTurn: number;
  toTurn: number;
  /** Number of the unit's own turns covered by the run. */
  ownTurns: number;
};

export type TurnCapHit = {
  file: string;
  turns: number;
  maxTurns: number;
  reasons: Array<'no-summary' | 'no-winner' | 'turn-cap'>;
};

export type HeldLeadHit = {
  file: string;
  player: PlayerId;
  fromTurn: number;
  toTurn: number;
  turns: number;
  minLeadPct: number;
  maxLeadPct: number;
  /** Whoever ended up winning, for context. */
  winner: PlayerId | null;
};

export type MineResult = {
  flags: {
    uncontestedCapture: UncontestedCaptureHit[];
    stalledUnit: StalledUnitHit[];
    turnCapHit: TurnCapHit[];
    heldLeadNoWin: HeldLeadHit[];
  };
  scanned: number;
  parseErrors: Array<{ file: string; error: string }>;
};

export const FLAG_NAMES = [
  'uncontestedCapture',
  'stalledUnit',
  'turnCapHit',
  'heldLeadNoWin',
] as const;
export type FlagName = (typeof FLAG_NAMES)[number];

// ────────────────────────────── shared helpers ───────────────────────────────

function coordKey(c: Coord): string {
  return `${c.x},${c.y}`;
}

/**
 * Striking distance of a unit, approximated as
 *   move + maxRange + 1.
 *
 * This is deliberately generous and deliberately cheap. A real reachability
 * test would run the pathfinder from every candidate tile (terrain costs,
 * blockers, ZOC-free but occupancy-limited), which is O(units x tiles) per
 * action and would dominate a 2000-file scan. Manhattan `move + maxRange`
 * is the upper bound on what a unit could threaten across open ground; the
 * `+ 1` absorbs the one-tile slack of "and the capturer may step toward you".
 *
 * Consequences: over-approximate (a unit walled off by mountains or water
 * counts as in-reach), so `uncontestedCapture` is a screening flag — every hit
 * needs an eyeball on the replay before it becomes a tuning lever. It never
 * under-reports, which is the property we want from a miner.
 */
export function strikingDistance(unitType: UnitType): number {
  const def = UNITS[unitType];
  return def.move + def.maxRange + 1;
}

/** HP-weighted unit cost, matching `adjudicate` in src/cli/round-robin.ts. */
export function hpWeightedCost(state: GameState, player: PlayerId): number {
  let n = 0;
  for (const u of Object.values(state.units)) {
    if (u.owner === player) n += UNITS[u.type].cost * (u.hp / 100);
  }
  return n;
}

/** Lead of `mine` over `theirs` as a percentage; guards a zero denominator. */
export function leadPercent(mine: number, theirs: number): number {
  return ((mine - theirs) / Math.max(theirs, 1)) * 100;
}

export type TurnRecord = {
  turn: number;
  /** The player whose turn this record closes. */
  player: PlayerId;
  /** Index into `states`. */
  index: number;
  state: GameState;
  /** True for a trailing turn that never reached its END_TURN. */
  partial: boolean;
};

/**
 * End-of-turn snapshots. A turn boundary is detected from the state itself
 * (`turn` incremented) rather than from action types, so a log whose END_TURNs
 * were no-ops (game already over) doesn't produce phantom turns. A trailing
 * partial turn — the usual shape of a match that ends on a winning capture —
 * is included only if it actually contains actions.
 */
export function turnRecords(states: readonly GameState[]): TurnRecord[] {
  const out: TurnRecord[] = [];
  for (let i = 0; i + 1 < states.length; i++) {
    const a = states[i]!;
    const b = states[i + 1]!;
    if (b.turn !== a.turn) {
      out.push({ turn: a.turn, player: a.currentPlayer, index: i, state: a, partial: false });
    }
  }
  const last = states.length - 1;
  const lastBoundary = out.length > 0 ? out[out.length - 1]!.index : -1;
  if (last > lastBoundary + 1 || (out.length === 0 && last >= 0)) {
    const s = states[last]!;
    out.push({ turn: s.turn, player: s.currentPlayer, index: last, state: s, partial: true });
  }
  return out;
}

// ───────────────────────────── flag: uncontested ─────────────────────────────

/**
 * An enemy unit completed a capture of player P's tile while P had at least one
 * unit in striking distance (see `strikingDistance`) that never ATTACKed the
 * capturer during the capture window.
 *
 * The window runs from the state in which the capturer's progress was last 0
 * on that tile up to the action that flipped ownership — i.e. every turn P had
 * to notice and respond. Detection keys off the ownership flip in the state
 * (not off CAPTURE actions) because END_TURN auto-captures too, so a flip can
 * land without any CAPTURE action in the log.
 *
 * Neutral tiles are ignored: only a flip away from a real owner is a failure to
 * contest. Loaded cargo is not counted as a defender (it cannot attack).
 */
export function uncontestedCapture(log: MinedLog): UncontestedCaptureHit[] {
  const { states, parsed, file } = log;
  const hits: UncontestedCaptureHit[] = [];

  for (let i = 0; i + 1 < states.length; i++) {
    const prev = states[i]!;
    const next = states[i + 1]!;
    for (let y = 0; y < prev.map.length; y++) {
      const prevRow = prev.map[y]!;
      const nextRow = next.map[y]!;
      for (let x = 0; x < prevRow.length; x++) {
        const before = prevRow[x]!;
        const after = nextRow[x]!;
        if (before.owner === after.owner) continue;
        const victim = before.owner;
        const newOwner = after.owner;
        if (victim === null || newOwner === null || victim === newOwner) continue;

        const capturer = Object.values(next.units).find(
          (u) => u.owner === newOwner && u.loadedIn === undefined && u.pos.x === x && u.pos.y === y,
        );
        if (!capturer) continue;

        // Walk back to the state where this unit's progress on this tile was 0.
        let start = i;
        while (start > 0) {
          const s = states[start]!;
          const u = s.units[capturer.id];
          if (!u || u.pos.x !== x || u.pos.y !== y || u.captureProgress === 0) break;
          start -= 1;
        }

        // Defenders in reach at any point in the window.
        const tile: Coord = { x, y };
        const candidates = new Map<UnitId, string>();
        for (let k = start; k <= i; k++) {
          for (const u of Object.values(states[k]!.units)) {
            if (u.owner !== victim || u.loadedIn !== undefined) continue;
            if (manhattan(u.pos, tile) <= strikingDistance(u.type)) candidates.set(u.id, u.type);
          }
        }
        if (candidates.size === 0) continue;

        // Anyone who actually swung at the capturer is not idle.
        for (let k = start; k <= i; k++) {
          const act = parsed.actions[k];
          if (act && act.type === 'ATTACK' && act.targetId === capturer.id) {
            candidates.delete(act.attackerId);
          }
        }
        if (candidates.size === 0) continue;

        hits.push({
          file,
          tile,
          terrain: after.terrain,
          victim,
          capturerId: capturer.id,
          capturerType: capturer.type,
          idleDefenderIds: [...candidates.keys()],
          fromTurn: states[start]!.turn,
          toTurn: prev.turn,
        });
      }
    }
  }
  return hits;
}

// ─────────────────────────────── flag: stalled ───────────────────────────────

/**
 * A unit that spent >= `stallTurns` consecutive own-turns confined to at most
 * two tiles — parked (A,A,A,...) or pacing (A,B,A,B,...). Positions are sampled
 * at the end of each of the unit's own turns; a run of <= 2 distinct positions
 * covers both the strict oscillation and the sloppier A,A,B,B,A variant.
 *
 * Excluded (all legitimate reasons to hold a tile), by breaking the run:
 *  - mid-capture (captureProgress > 0)
 *  - loaded in a transport
 *  - standing on its owner's HQ (garrison duty)
 */
export function stalledUnit(
  log: MinedLog,
  opts: Pick<MineOptions, 'stallTurns'> = DEFAULT_OPTIONS,
): StalledUnitHit[] {
  const records = turnRecords(log.states);
  const k = Math.max(1, opts.stallTurns);

  type Sample = { turn: number; pos: Coord; eligible: boolean; ownIndex: number; type: string };
  const perUnit = new Map<UnitId, { owner: PlayerId; samples: Sample[] }>();
  const ownTurnCount: Record<PlayerId, number> = { 0: 0, 1: 0 };

  for (const rec of records) {
    const ownIndex = ownTurnCount[rec.player]++;
    for (const u of Object.values(rec.state.units)) {
      if (u.owner !== rec.player) continue;
      const tile = tileAt(rec.state.map, u.pos);
      const onOwnHq = tile.terrain === 'hq' && tile.owner === u.owner;
      const eligible = u.captureProgress === 0 && u.loadedIn === undefined && !onOwnHq;
      let entry = perUnit.get(u.id);
      if (!entry) {
        entry = { owner: u.owner, samples: [] };
        perUnit.set(u.id, entry);
      }
      entry.samples.push({ turn: rec.turn, pos: u.pos, eligible, ownIndex, type: u.type });
    }
  }

  const hits: StalledUnitHit[] = [];
  for (const [unitId, entry] of perUnit) {
    const s = entry.samples;
    let lastEnd = -1;
    for (let i = 0; i < s.length; i++) {
      if (!s[i]!.eligible) continue;
      const seen = new Set<string>();
      let j = i;
      while (j < s.length) {
        const cur = s[j]!;
        // Contiguity: a gap in own-turn indices means the unit blinked out
        // (destroyed, or a log that starts mid-match) — never bridge one.
        if (j > i && cur.ownIndex !== s[j - 1]!.ownIndex + 1) break;
        if (!cur.eligible) break;
        const key = coordKey(cur.pos);
        if (!seen.has(key) && seen.size >= 2) break;
        seen.add(key);
        j += 1;
      }
      const len = j - i;
      // Windows grow monotonically, so `j > lastEnd` drops runs already
      // contained in one we reported.
      if (len >= k && j > lastEnd) {
        lastEnd = j;
        const tiles = [...seen].map((key) => {
          const [x, y] = key.split(',');
          return { x: Number(x), y: Number(y) };
        });
        hits.push({
          file: log.file,
          unitId,
          unitType: s[i]!.type,
          owner: entry.owner,
          tiles,
          fromTurn: s[i]!.turn,
          toTurn: s[j - 1]!.turn,
          ownTurns: len,
        });
      }
    }
  }
  return hits;
}

// ─────────────────────────────── flag: turn cap ──────────────────────────────

/**
 * The match never resolved: no summary at all (abandoned capture), a summary
 * with `winner: null`, or a turn count that reached the configured cap.
 * At most one hit per file; `reasons` lists every condition that tripped.
 */
export function turnCapHit(
  log: MinedLog,
  opts: Pick<MineOptions, 'defaultMaxTurns'> = DEFAULT_OPTIONS,
): TurnCapHit[] {
  const { parsed, states, file } = log;
  const maxTurns = parsed.header.maxTurns ?? opts.defaultMaxTurns;
  const finalState = states[states.length - 1];
  const turns = parsed.summary?.turns ?? finalState?.turn ?? 0;
  const reasons: TurnCapHit['reasons'] = [];
  if (!parsed.summary) reasons.push('no-summary');
  else if (parsed.summary.winner === null) reasons.push('no-winner');
  if (turns >= maxTurns) reasons.push('turn-cap');
  if (reasons.length === 0) return [];
  return [{ file, turns, maxTurns, reasons }];
}

// ────────────────────────────── flag: held lead ──────────────────────────────

/**
 * A player held an HP-weighted material lead of >= `leadPct` for >= `leadTurns`
 * consecutive turns and did not convert it into a win inside that window.
 * Cost model matches `adjudicate` in round-robin.ts: sum(UNITS[type].cost * hp/100).
 *
 * A run that ends with the game ending in that player's win is not a hit — the
 * lead was converted. Everything else is: the material advantage existed and
 * nothing came of it for twenty-plus turns.
 */
export function heldLeadNoWin(
  log: MinedLog,
  opts: Pick<MineOptions, 'leadPct' | 'leadTurns'> = DEFAULT_OPTIONS,
): HeldLeadHit[] {
  const records = turnRecords(log.states);
  if (records.length === 0) return [];
  const finalState = log.states[log.states.length - 1]!;
  // `?? ` would swallow a legitimate `winner: null` summary, so branch explicitly.
  const winner = log.parsed.summary ? log.parsed.summary.winner : finalState.winner;
  const hits: HeldLeadHit[] = [];

  for (const player of [0, 1] as PlayerId[]) {
    const other: PlayerId = player === 0 ? 1 : 0;
    const leads = records.map((r) =>
      leadPercent(hpWeightedCost(r.state, player), hpWeightedCost(r.state, other)),
    );
    let i = 0;
    while (i < leads.length) {
      if (leads[i]! < opts.leadPct) {
        i += 1;
        continue;
      }
      let j = i;
      while (j < leads.length && leads[j]! >= opts.leadPct) j += 1;
      const len = j - i;
      const convertedAtEnd = j === leads.length && winner === player;
      if (len >= opts.leadTurns && !convertedAtEnd) {
        const window = leads.slice(i, j);
        hits.push({
          file: log.file,
          player,
          fromTurn: records[i]!.turn,
          toTurn: records[j - 1]!.turn,
          turns: len,
          minLeadPct: Math.min(...window),
          maxLeadPct: Math.max(...window),
          winner,
        });
      }
      i = j;
    }
  }
  return hits;
}

// ────────────────────────────── reconstruction ───────────────────────────────

const mapCache = new Map<string, unknown>();

async function readMapJson(name: string): Promise<unknown> {
  const cached = mapCache.get(name);
  if (cached !== undefined) return cached;
  const json = JSON.parse(await fs.readFile(path.join(MAPS_DIR, `${name}.json`), 'utf8')) as unknown;
  mapCache.set(name, json);
  return json;
}

/**
 * Parse a log and re-fold it through the reducer. Mirrors the reconstruction in
 * src/cli/replay-file.ts: map JSON by header name, fog memory when the header
 * says the game was played under fog.
 */
export async function loadMinedLog(file: string, text: string): Promise<MinedLog> {
  const parsed = parseLog(text);
  const base = loadMap(await readMapJson(parsed.header.map));
  const initial = parsed.header.fog === true ? enableFogMemory(base) : base;
  const result = replay(initial, parsed.actions);
  return { file, parsed, states: result.states };
}

/** Run every detector over one replayed match. */
export function mineLog(log: MinedLog, opts: MineOptions = DEFAULT_OPTIONS): MineResult['flags'] {
  return {
    uncontestedCapture: uncontestedCapture(log),
    stalledUnit: stalledUnit(log, opts),
    turnCapHit: turnCapHit(log, opts),
    heldLeadNoWin: heldLeadNoWin(log, opts),
  };
}

function emptyResult(): MineResult {
  return {
    flags: { uncontestedCapture: [], stalledUnit: [], turnCapHit: [], heldLeadNoWin: [] },
    scanned: 0,
    parseErrors: [],
  };
}

/** Mine a stream of (file, text) pairs. Bad logs land in `parseErrors`. */
export async function mineSources(
  sources: AsyncIterable<{ file: string; text: string }>,
  opts: MineOptions = DEFAULT_OPTIONS,
): Promise<MineResult> {
  const out = emptyResult();
  for await (const { file, text } of sources) {
    let log: MinedLog;
    try {
      log = await loadMinedLog(file, text);
    } catch (err) {
      out.parseErrors.push({ file, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    out.scanned += 1;
    try {
      const flags = mineLog(log, opts);
      out.flags.uncontestedCapture.push(...flags.uncontestedCapture);
      out.flags.stalledUnit.push(...flags.stalledUnit);
      out.flags.turnCapHit.push(...flags.turnCapHit);
      out.flags.heldLeadNoWin.push(...flags.heldLeadNoWin);
    } catch (err) {
      out.parseErrors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

// ───────────────────────────────── sources ───────────────────────────────────

export async function findLogFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await findLogFiles(full)));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

async function* localSources(
  dir: string,
  limit: number | null,
): AsyncGenerator<{ file: string; text: string }> {
  const files = await findLogFiles(dir);
  const chosen = limit === null ? files : files.slice(0, limit);
  for (const f of chosen) {
    yield { file: path.relative(process.cwd(), f) || f, text: await fs.readFile(f, 'utf8') };
  }
}

/** Scan a directory tree of *.jsonl match logs. */
export async function mineDir(
  dir: string,
  opts: MineOptions = DEFAULT_OPTIONS,
  limit: number | null = null,
): Promise<MineResult> {
  return mineSources(localSources(dir, limit), opts);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function* remoteSources(
  base: string,
  limit: number | null,
): AsyncGenerator<{ file: string; text: string }> {
  const listing = JSON.parse(await fetchText(`${base}/api/replays`)) as Array<{
    name: string;
    size?: number;
    mtime?: string;
  }>;
  const chosen = limit === null ? listing : listing.slice(0, limit);
  for (const entry of chosen) {
    yield { file: entry.name, text: await fetchText(`${base}/api/replays/${entry.name}`) };
  }
}

// ─────────────────────────────────── CLI ─────────────────────────────────────

type Args = MineOptions & {
  dir: string | null;
  remote: boolean;
  base: string;
  json: boolean;
  limit: number | null;
};

export function parseArgs(argv: ReadonlyArray<string>): Args {
  const args: Args = {
    ...DEFAULT_OPTIONS,
    dir: null,
    remote: false,
    base: DEFAULT_BASE,
    json: false,
    limit: null,
  };
  const num = (raw: string | undefined, flag: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${flag} expects a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dir') args.dir = argv[++i] ?? null;
    else if (a === '--remote') args.remote = true;
    else if (a === '--base') args.base = argv[++i] ?? DEFAULT_BASE;
    else if (a === '--json') args.json = true;
    else if (a === '--stall-turns') args.stallTurns = num(argv[++i], a);
    else if (a === '--lead-pct') args.leadPct = num(argv[++i], a);
    else if (a === '--lead-turns') args.leadTurns = num(argv[++i], a);
    else if (a === '--max-turns') args.defaultMaxTurns = num(argv[++i], a);
    else if (a === '--limit') args.limit = num(argv[++i], a);
    else throw new Error(`unknown flag ${a}`);
  }
  if (args.dir === null && !args.remote) {
    throw new Error(
      'usage: npx tsx scripts/mine-replays.ts (--dir <logDir> | --remote [--base URL])\n' +
        '       [--stall-turns 6] [--lead-pct 40] [--lead-turns 20] [--max-turns 120]\n' +
        '       [--limit N] [--json]',
    );
  }
  return args;
}

function describe(name: FlagName, hit: unknown): string {
  switch (name) {
    case 'uncontestedCapture': {
      const h = hit as UncontestedCaptureHit;
      return `${h.terrain} (${h.tile.x},${h.tile.y}) taken from p${h.victim} by ${h.capturerType} ${h.capturerId}, turns ${h.fromTurn}-${h.toTurn}, idle: ${h.idleDefenderIds.join(',')}`;
    }
    case 'stalledUnit': {
      const h = hit as StalledUnitHit;
      const tiles = h.tiles.map((t) => `(${t.x},${t.y})`).join('<->');
      return `p${h.owner} ${h.unitType} ${h.unitId} on ${tiles} for ${h.ownTurns} own-turns, turns ${h.fromTurn}-${h.toTurn}`;
    }
    case 'turnCapHit': {
      const h = hit as TurnCapHit;
      return `${h.turns} turns (cap ${h.maxTurns}) — ${h.reasons.join(', ')}`;
    }
    case 'heldLeadNoWin': {
      const h = hit as HeldLeadHit;
      return `p${h.player} led ${h.minLeadPct.toFixed(0)}-${h.maxLeadPct.toFixed(0)}% for ${h.turns} turns (${h.fromTurn}-${h.toTurn}), winner ${h.winner === null ? 'none' : `p${h.winner}`}`;
    }
  }
}

const MAX_ROWS = 25;

/** Last two path segments — enough to tell round-robin dirs apart. */
function shortPath(file: string): string {
  const parts = file.split(path.sep);
  return parts.slice(-2).join('/');
}

function report(result: MineResult, args: Args): void {
  const source = args.remote ? `${args.base}/api/replays` : args.dir;
  console.log(`── Replay degeneracy scan (${source}) ──\n`);
  console.log(
    `scanned: ${result.scanned}   parse errors: ${result.parseErrors.length}   ` +
      `thresholds: stall>=${args.stallTurns} lead>=${args.leadPct}%/${args.leadTurns}t cap=${args.defaultMaxTurns}\n`,
  );

  for (const name of FLAG_NAMES) {
    const hits = result.flags[name] as Array<{ file: string }>;
    const byFile = new Map<string, { file: string }>();
    for (const h of hits) if (!byFile.has(h.file)) byFile.set(h.file, h);
    const pct = result.scanned > 0 ? ((byFile.size / result.scanned) * 100).toFixed(1) : '0.0';
    console.log(`── ${name}: ${hits.length} hit(s) across ${byFile.size} file(s) (${pct}% of scanned)`);
    let shown = 0;
    for (const [file, first] of byFile) {
      if (shown >= MAX_ROWS) {
        console.log(`   … and ${byFile.size - shown} more file(s)`);
        break;
      }
      console.log(`   ${shortPath(file).padEnd(60)} ${describe(name, first)}`);
      shown += 1;
    }
    console.log('');
  }

  if (result.parseErrors.length > 0) {
    console.log(`── unparseable logs: ${result.parseErrors.length}`);
    for (const e of result.parseErrors.slice(0, MAX_ROWS)) {
      console.log(`   ${shortPath(e.file).padEnd(60)} ${e.error}`);
    }
    if (result.parseErrors.length > MAX_ROWS) {
      console.log(`   … and ${result.parseErrors.length - MAX_ROWS} more`);
    }
    console.log('');
  }

  console.log('── summary ──');
  console.log(`   ${'flag'.padEnd(22)} ${'hits'.padStart(6)} ${'files'.padStart(6)} ${'% files'.padStart(8)}`);
  for (const name of FLAG_NAMES) {
    const hits = result.flags[name] as Array<{ file: string }>;
    const files = new Set(hits.map((h) => h.file)).size;
    const pct = result.scanned > 0 ? ((files / result.scanned) * 100).toFixed(1) : '0.0';
    console.log(
      `   ${name.padEnd(22)} ${String(hits.length).padStart(6)} ${String(files).padStart(6)} ${pct.padStart(8)}`,
    );
  }
  console.log(
    `   ${'(scanned)'.padEnd(22)} ${''.padStart(6)} ${String(result.scanned).padStart(6)}` +
      `   parse errors: ${result.parseErrors.length}`,
  );
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv);
  // The reducer logs every action under `engine`; a scan would emit millions
  // of lines. Replay/match categories likewise.
  setLogEnabled('engine', false);
  setLogEnabled('match', false);
  setLogEnabled('replay', false);
  setLogEnabled('ai', false);

  const result = args.remote
    ? await mineSources(remoteSources(args.base, args.limit), args)
    : await mineDir(args.dir!, args, args.limit);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  report(result, args);
}

const isEntry =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntry) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[mine-replays] error: ${msg}`);
    process.exit(1);
  });
}
