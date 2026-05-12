// CLI runner — Phase 2 end-to-end proof.
//
//   npx tsx src/cli/run-match.ts --map duel --max-turns 200 --seed 42
//
// Drives an engine match using a tiny "stub AI" that picks the first legal
// action it enumerates (with a seeded RNG breaking ties). This is NOT the
// real Tier-1 utility AI from Phase 4 — it's a deliberate floor whose only
// job is to demonstrate the engine can be SEEDED from JSON data and ticks
// turns end to end. Phase 4 owns the actual AI.
//
// The heavy lifting lives in `runMatch` so the integration test can drive
// the same code path without spawning a subprocess.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMap } from '../engine/data/loader';
import { reduce } from '../engine/core/reducer';
import { isLegalAction } from '../engine/core/validators';
import { reachableTiles } from '../engine/systems/pathfinding';
import { attackableTargets } from '../engine/queries/selectors';
import { UNITS, INCOME_TERRAIN } from '../engine/data';
import { createRng, rngInt } from '../engine/core/rng';
import { isCapturable, tileAt } from '../engine/core/types';
import type { Rng } from '../engine/core/rng';
import type {
  Action,
  Coord,
  GameState,
  PlayerId,
} from '../engine/core/types';
import { log, setLogEnabled } from '../engine/core/logger';

// ─────────────────────────── Public types ────────────────────────────────────

export type RunMatchOptions = {
  mapName: string;
  /** Hard cap on number of turns (each END_TURN counts as one). */
  maxTurns: number;
  seed: number;
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

export type RunMatchResult = {
  finalState: GameState;
  turns: number;
  winner: PlayerId | null;
  unitCount: Record<PlayerId, number>;
  funds: Record<PlayerId, number>;
  elapsedMs: number;
  actions: ActionLogEntry[];
  logPath: string | null;
};

// ─────────────────────────── Stub AI ─────────────────────────────────────────

/**
 * Enumerate a modest set of legal actions for the current player. We do NOT
 * exhaustively enumerate every possible move target — that's Phase 4's job.
 * For each unit, we generate:
 *   - WAIT (if it hasn't acted)
 *   - CAPTURE (if it's standing on a capturable enemy/neutral tile)
 *   - ATTACK against any in-range enemy
 *   - MOVE to a random reachable tile
 * Plus BUILD actions for any unoccupied owned factory the player can afford.
 * Plus END_TURN as the fallback.
 *
 * The stub returns the FIRST candidate from a randomised order, which keeps
 * matches lively without devolving into pure WAIT chains.
 */
function pickStubAction(state: GameState, rng: Rng): Action {
  const player = state.currentPlayer;
  const myUnits = Object.values(state.units).filter((u) => u.owner === player);

  // Shuffle units so order varies seed-to-seed.
  const shuffled = shuffle(myUnits, rng);

  for (const unit of shuffled) {
    if (unit.hasActed && unit.hasMoved) continue;

    // 1. CAPTURE if the unit is sitting on a flippable capturable tile.
    if (!unit.hasActed) {
      const tile = tileAt(state.map, unit.pos);
      if (
        isCapturable(tile.terrain) &&
        tile.owner !== unit.owner &&
        UNITS[unit.type].canCapture
      ) {
        const action: Action = { type: 'CAPTURE', unitId: unit.id };
        if (isLegalAction(state, action).legal) return action;
      }
    }

    // 2. ATTACK any in-range enemy (only if attacker hasn't acted).
    if (!unit.hasActed) {
      const targets = attackableTargets(state, unit);
      if (targets.length > 0) {
        const target = pickRandom(targets, rng);
        const action: Action = {
          type: 'ATTACK',
          attackerId: unit.id,
          targetId: target.id,
        };
        if (isLegalAction(state, action).legal) return action;
      }
    }

    // 3. MOVE somewhere reachable (only if hasn't moved). Bias toward the
    //    enemy HQ to keep the match progressing instead of dithering.
    if (!unit.hasMoved) {
      const reachable = reachableTiles(state, unit).filter(
        (r) => r.path.length > 0,
      );
      if (reachable.length > 0) {
        const enemyHq = state.players[otherPlayer(player)].hq;
        const towardHq = reachable
          .slice()
          .sort((a, b) => manhattan(a.coord, enemyHq) - manhattan(b.coord, enemyHq));
        // 70% chance pick a tile in the top-third closest to enemy HQ; else random.
        const useBiased = rng() < 0.7 && towardHq.length > 0;
        const pool = useBiased
          ? towardHq.slice(0, Math.max(1, Math.ceil(towardHq.length / 3)))
          : reachable;
        const dest = pickRandom(pool, rng);
        const action: Action = {
          type: 'MOVE',
          unitId: unit.id,
          path: dest.path,
        };
        if (isLegalAction(state, action).legal) return action;
      }
      // Fallback: WAIT.
      const wait: Action = { type: 'WAIT', unitId: unit.id };
      if (isLegalAction(state, wait).legal) return wait;
    } else if (!unit.hasActed) {
      // Has moved but not acted — wait it out.
      const wait: Action = { type: 'WAIT', unitId: unit.id };
      if (isLegalAction(state, wait).legal) return wait;
    }
  }

  // 4. BUILD on any unoccupied owned factory we can afford.
  for (let y = 0; y < state.map.length; y++) {
    const row = state.map[y]!;
    for (let x = 0; x < row.length; x++) {
      const tile = row[x]!;
      if (tile.terrain !== 'factory') continue;
      if (tile.owner !== player) continue;
      if (occupied(state, { x, y })) continue;
      const buyable = (['infantry', 'recon', 'tank'] as const).filter(
        (t) => state.players[player].funds >= UNITS[t].cost,
      );
      if (buyable.length === 0) continue;
      const unitType = pickRandom(buyable, rng);
      const action: Action = {
        type: 'BUILD',
        at: { x, y },
        unitType,
        owner: player,
      };
      if (isLegalAction(state, action).legal) return action;
    }
  }

  // 5. Nothing useful — end the turn.
  return { type: 'END_TURN' };
}

function shuffle<T>(arr: ReadonlyArray<T>, rng: Rng): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rngInt(rng, i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

function pickRandom<T>(arr: ReadonlyArray<T>, rng: Rng): T {
  if (arr.length === 0) throw new Error('pickRandom: empty array');
  return arr[rngInt(rng, arr.length)] as T;
}

function manhattan(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function otherPlayer(p: PlayerId): PlayerId {
  return (p === 0 ? 1 : 0) as PlayerId;
}

function occupied(state: GameState, c: Coord): boolean {
  for (const u of Object.values(state.units)) {
    if (u.pos.x === c.x && u.pos.y === c.y) return true;
  }
  return false;
}

// ─────────────────────────── Match runner ────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..');
const PROJECT_ROOT = path.resolve(SRC_ROOT, '..');

async function readMapJson(mapName: string): Promise<unknown> {
  const file = path.join(SRC_ROOT, 'data', 'maps', `${mapName}.json`);
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text);
}

/**
 * Run a match to completion (or maxTurns) with the stub AI. Returns the
 * final state, action log, and summary. Optionally writes a JSONL of every
 * action to `logs/match-<timestamp>-<seed>.jsonl`.
 */
export async function runMatch(opts: RunMatchOptions): Promise<RunMatchResult> {
  const writeLog = opts.writeLog ?? true;
  const logDir = opts.logDir ?? path.join(PROJECT_ROOT, 'logs');

  const mapJson = opts.mapJson ?? (await readMapJson(opts.mapName));
  const state0 = loadMap(mapJson);

  const rng = createRng(opts.seed);
  const start = Date.now();
  let state = state0;
  const actions: ActionLogEntry[] = [];

  // Safety counter — independent of state.turn so it bounds even pathological loops.
  let totalActions = 0;
  const actionsHardCap = opts.maxTurns * 1000;

  while (state.winner === null && state.turn <= opts.maxTurns && totalActions < actionsHardCap) {
    const action = pickStubAction(state, rng);
    const player = state.currentPlayer;
    log('match', 'ai pick', { turn: state.turn, player, action });

    const next = reduce(state, action);
    // Defensive: if the engine rejected the action, the state is unchanged.
    // Force-end the turn to avoid an infinite loop on a broken stub.
    if (next === state) {
      log('match', 'action no-op; forcing END_TURN', { player });
      const forced = reduce(state, { type: 'END_TURN' });
      actions.push({ turn: state.turn, player, action: { type: 'END_TURN' } });
      state = forced;
    } else {
      actions.push({ turn: state.turn, player, action });
      state = next;
    }
    totalActions += 1;
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
    logPath,
  };
}

// ─────────────────────────── Argv parsing + entry ────────────────────────────

type ParsedArgs = { map: string; maxTurns: number; seed: number; quiet: boolean };

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const defaults: ParsedArgs = {
    map: 'duel',
    maxTurns: 200,
    seed: 1,
    quiet: false,
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
    } else if (a === '--quiet') {
      out.quiet = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(
    [
      'Usage: tsx src/cli/run-match.ts [options]',
      '',
      '  --map <name>       map to load (default: duel)',
      '  --max-turns <N>    hard turn cap (default: 200)',
      '  --seed <N>         RNG seed (default: 1)',
      '  --quiet            suppress per-action log lines',
      '  --help, -h         show this help',
    ].join('\n'),
  );
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
  } else {
    // Engine logs every action — too noisy for a CLI summary. Keep match on.
    setLogEnabled('engine', false);
  }

  console.log(`[match] starting map=${args.map} seed=${args.seed} maxTurns=${args.maxTurns}`);
  const result = await runMatch({
    mapName: args.map,
    maxTurns: args.maxTurns,
    seed: args.seed,
  });

  const p0Props = countProperties(result.finalState, 0);
  const p1Props = countProperties(result.finalState, 1);

  console.log('─────────────────────────────────────────────────');
  console.log(`map:            ${args.map}`);
  console.log(`seed:           ${args.seed}`);
  console.log(`turns played:   ${result.turns}`);
  console.log(`winner:         ${result.winner === null ? '(none — turn cap)' : `player ${result.winner}`}`);
  console.log(`elapsed:        ${result.elapsedMs} ms`);
  console.log(`units p0/p1:    ${result.unitCount[0]} / ${result.unitCount[1]}`);
  console.log(`funds p0/p1:    ${result.funds[0]} / ${result.funds[1]}`);
  console.log(`properties:     p0=${p0Props}  p1=${p1Props}`);
  console.log(`log file:       ${result.logPath ?? '(none)'}`);
  console.log('─────────────────────────────────────────────────');
}

// Detect "run as a script" without falling foul of ESM. `import.meta.url`
// resolves to a file:// URL pointing at this very module; `process.argv[1]`
// is the script the user (or `tsx`) launched.
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
