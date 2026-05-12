// Replay CLI.
//
//   npx tsx src/cli/replay.ts <path-to-jsonl-log>
//   npx tsx src/cli/replay.ts <path-to-jsonl-log> --map duel
//
// Replays a match log line-by-line through the reducer and prints a summary.
// If the JSONL header includes a `map` field (as the run-match runner writes
// today), we use it; otherwise the `--map` flag is required.
//
// Output:
//   - Header line echoing the map + seed.
//   - Per-turn summary: action count, current player, winner-if-any.
//   - Final state summary: turns, winner, unit count, funds.
//
// With `--verbose`, each action prints on its own line.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMap } from '../engine/data/loader';
import { parseLog, replay } from '../engine/replay';
import { setLogEnabled } from '../engine/core/logger';
import type { GameState, PlayerId } from '../engine/core/types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..');

type Args = {
  logPath: string;
  mapOverride?: string;
  verbose: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { logPath: '', verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--map') {
      const v = argv[++i];
      if (!v) throw new Error('--map requires a value');
      out.mapOverride = v;
    } else if (a === '--verbose' || a === '-v') {
      out.verbose = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (!out.logPath) {
      out.logPath = a!;
    } else {
      throw new Error(`unexpected argument: ${a as string}`);
    }
  }
  if (!out.logPath) {
    printHelp();
    throw new Error('missing log path');
  }
  return out;
}

function printHelp(): void {
  console.log(
    [
      'Usage: tsx src/cli/replay.ts <log.jsonl> [options]',
      '',
      '  --map <name>   override map name from the log header',
      '  --verbose, -v  print every action',
      '  --help, -h     show this help',
    ].join('\n'),
  );
}

async function readMapJson(mapName: string): Promise<unknown> {
  const file = path.join(SRC_ROOT, 'data', 'maps', `${mapName}.json`);
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text);
}

function countOwnedUnits(state: GameState, player: PlayerId): number {
  let n = 0;
  for (const u of Object.values(state.units)) if (u.owner === player) n += 1;
  return n;
}

async function main(argv: readonly string[]): Promise<void> {
  setLogEnabled('engine', false);
  setLogEnabled('match', false);
  setLogEnabled('replay', false);

  const args = parseArgs(argv);
  const text = await fs.readFile(args.logPath, 'utf8');
  const parsed = parseLog(text);
  const mapName = args.mapOverride ?? parsed.header.map;
  if (!mapName) throw new Error('no map in header and no --map override');
  const mapJson = await readMapJson(mapName);
  const initial = loadMap(mapJson);

  console.log(
    `[replay] log=${args.logPath} map=${mapName} seed=${parsed.header.seed} p0=${parsed.header.p0 ?? '?'} p1=${parsed.header.p1 ?? '?'} actions=${parsed.actions.length}`,
  );

  const result = replay(initial, parsed.actions);

  // Turn-by-turn summary.
  let lastTurn = -1;
  for (let i = 0; i < parsed.actions.length; i++) {
    const a = parsed.actions[i]!;
    const s = result.states[i + 1]!;
    if (s.turn !== lastTurn) {
      lastTurn = s.turn;
      // Skip detail lines unless --verbose. Show one short header per turn boundary.
    }
    if (args.verbose) {
      console.log(`  [${i.toString().padStart(4)}] turn=${s.turn} player=${s.currentPlayer} action=${a.type}`);
    }
  }

  const final = result.finalState;
  console.log('─────────────────────────────────────────────────');
  console.log(`turns:          ${final.turn}`);
  console.log(`winner:         ${final.winner === null ? '(none)' : `player ${final.winner}`}`);
  console.log(`units p0/p1:    ${countOwnedUnits(final, 0)} / ${countOwnedUnits(final, 1)}`);
  console.log(`funds p0/p1:    ${final.players[0].funds} / ${final.players[1].funds}`);
  console.log(`skipped (no-op) actions: ${result.skipped.length}`);
  if (parsed.summary && parsed.summary.winner !== final.winner) {
    console.error(
      `[replay] WARNING: summary winner=${String(parsed.summary.winner)} disagrees with replay winner=${String(final.winner)}`,
    );
  }
  console.log('─────────────────────────────────────────────────');
}

const isEntry =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntry) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[replay] error: ${msg}`);
    process.exit(1);
  });
}
