// Replay a captured match log — the debug entrypoint for games played on the
// deployed site (or anywhere a JSONL log came from).
//
//   npm run replay -- <file.jsonl>          replay a local log
//   npm run replay -- --latest              fetch + replay newest prod capture
//   npm run replay -- <name>.jsonl --remote fetch a specific prod capture
//   ... --dump N                            also print the state after action N
//
// Rebuilds the initial state from the header (map name + fog flag), folds the
// action stream through the reducer, and cross-checks the result against the
// recorded summary. A winner/turn mismatch or skipped actions mean the engine
// has drifted since the game was played — check out the header's `sha` and
// re-run to get the exact states the player saw.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMap } from '../engine/data/loader';
import { enableFogMemory } from '../engine/systems/memory';
import { parseLog, replay } from '../engine/replay';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..');

const DEFAULT_BASE = 'https://bats.joseffsmith.uk';

type Args = {
  source: string | null;
  latest: boolean;
  remote: boolean;
  base: string;
  dump: number | null;
};

function parseArgs(argv: ReadonlyArray<string>): Args {
  const args: Args = { source: null, latest: false, remote: false, base: DEFAULT_BASE, dump: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--latest') args.latest = true;
    else if (a === '--remote') args.remote = true;
    else if (a === '--base') args.base = argv[++i] ?? DEFAULT_BASE;
    else if (a === '--dump') args.dump = Number(argv[++i]);
    else if (!a.startsWith('--')) args.source = a;
    else throw new Error(`unknown flag ${a}`);
  }
  if (!args.latest && args.source === null) {
    throw new Error('usage: npm run replay -- <file.jsonl> | --latest [--base URL] [--dump N]');
  }
  return args;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

async function loadLogText(args: Args): Promise<{ text: string; label: string }> {
  if (args.latest) {
    const listing = (await JSON.parse(
      await fetchText(`${args.base}/api/replays`),
    )) as Array<{ name: string; mtime: string }>;
    if (listing.length === 0) throw new Error(`no replays stored at ${args.base}`);
    const newest = listing[0]!.name;
    return { text: await fetchText(`${args.base}/api/replays/${newest}`), label: newest };
  }
  if (args.remote) {
    const name = args.source!;
    return { text: await fetchText(`${args.base}/api/replays/${name}`), label: name };
  }
  return { text: await fs.readFile(args.source!, 'utf8'), label: args.source! };
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const args = parseArgs(argv);
  const { text, label } = await loadLogText(args);
  const parsed = parseLog(text);
  const h = parsed.header;

  const mapFile = path.join(SRC_ROOT, 'data', 'maps', `${h.map}.json`);
  const mapJson = JSON.parse(await fs.readFile(mapFile, 'utf8')) as unknown;
  const base = loadMap(mapJson);
  const initial = h.fog === true ? enableFogMemory(base) : base;

  const result = replay(initial, parsed.actions);
  const final = result.finalState;

  const recorded = parsed.summary;
  const winnerMatches = recorded === undefined || recorded.winner === final.winner;
  const drifted = result.skipped.length > 0 || !winnerMatches;

  console.log('─────────────────────────────────────────────────');
  console.log(`log:             ${label}`);
  console.log(`map:             ${h.map}${h.fog ? ' (fog)' : ''}`);
  console.log(`players:         p0=${h.p0 ?? '?'}  p1=${h.p1 ?? '?'}`);
  console.log(`captured:        ${h.startedAt ?? '?'}  sha=${h.sha ?? '?'}  client=${h.client ?? 'cli'}`);
  console.log(`actions:         ${parsed.actions.length} (${result.skipped.length} skipped as no-ops)`);
  console.log(`replayed final:  turn ${final.turn}, winner ${final.winner === null ? '(none)' : `player ${final.winner}`}`);
  if (recorded) {
    console.log(`recorded final:  turn ${recorded.turns}, winner ${recorded.winner === null ? '(none)' : `player ${recorded.winner}`}`);
  } else {
    console.log('recorded final:  (no summary — abandoned mid-match)');
  }
  if (drifted) {
    console.log('');
    console.log('⚠ REPLAY DRIFT: the reducer no longer reproduces this game.');
    console.log(`  The engine has changed since capture — try: git checkout ${h.sha ?? '<capture sha>'}`);
  }
  console.log('─────────────────────────────────────────────────');

  if (args.dump !== null) {
    const idx = Math.max(0, Math.min(result.states.length - 1, args.dump));
    console.log(JSON.stringify(result.states[idx], null, 2));
  }

  if (drifted) process.exit(2);
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
