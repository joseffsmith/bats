// Interactive driving REPL for the live game — a manual sibling of the e2e
// helpers. Spawns Vite + headless (or headful) Chromium, opens the game with
// `?debug=1`, pipes page console to the terminal, and reads commands on stdin:
//
//   state | units | unit <id> | click <x> <y> | menu <label> | endturn |
//   idle | shot <path> | eval <js> | save <path> | load <path> | help | quit
//
// Flags: --map --p0 --p1 --fog --seed --headful --url <full-url> --script <file>
//        --exit (leave after running --script instead of staying interactive)
//
//   npm run drive -- --map=duel --p1=balanced --seed=42
//   echo -e "state\nendturn\nstate\nquit" | npm run drive -- --script=/dev/stdin --exit

import * as readline from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser, Page } from 'puppeteer';
import {
  startVite,
  launchBrowser,
  gameUrl,
  openGame,
  awaitIdle,
  type ViteHandle,
} from './lib/browser-harness';

type Args = {
  map?: string;
  p0?: string;
  p1?: string;
  fog?: string;
  seed?: number;
  headful: boolean;
  url?: string;
  script?: string;
  exit: boolean;
};

function parseArgs(): Args {
  const out: Args = { headful: false, exit: false };
  for (const a of process.argv.slice(2)) {
    const kv = /^--([^=]+)=(.*)$/.exec(a);
    if (kv) {
      const [, k, v] = kv as unknown as [string, string, string];
      if (k === 'map') out.map = v;
      else if (k === 'p0') out.p0 = v;
      else if (k === 'p1') out.p1 = v;
      else if (k === 'fog') out.fog = v;
      else if (k === 'seed') out.seed = Number(v);
      else if (k === 'url') out.url = v;
      else if (k === 'script') out.script = v;
      continue;
    }
    if (a === '--headful') out.headful = true;
    else if (a === '--exit') out.exit = true;
  }
  return out;
}

/** Run one member expression against `window.__bats` in the page. */
function bats<T>(page: Page, body: string): Promise<T> {
  return page.evaluate((expr) => {
    const b = (window as unknown as { __bats: Record<string, unknown> }).__bats;
    return new Function('b', `return b.${expr};`)(b) as unknown;
  }, body) as Promise<T>;
}

type UnitLite = {
  id: string;
  type: string;
  owner: number;
  pos: { x: number; y: number };
  hp: number;
  hasActed: boolean;
};
type StateLite = {
  turn: number;
  currentPlayer: number;
  winner: number | null;
  players: Record<number, { funds: number }>;
  units: Record<string, UnitLite>;
};

async function summariseState(page: Page): Promise<string> {
  const s = await bats<StateLite>(page, 'getState()');
  const units = Object.values(s.units);
  const p0 = units.filter((u) => u.owner === 0).length;
  const p1 = units.filter((u) => u.owner === 1).length;
  return [
    `turn ${s.turn}  currentPlayer P${s.currentPlayer + 1}  winner ${s.winner ?? '—'}`,
    `funds P1=$${s.players[0]?.funds ?? 0} P2=$${s.players[1]?.funds ?? 0}`,
    `units P1=${p0} P2=${p1} (total ${units.length})`,
  ].join('\n');
}

async function clickTile(page: Page, x: number, y: number): Promise<void> {
  const p = await bats<{ x: number; y: number }>(page, `tileToScreen({x:${x},y:${y}})`);
  await page.mouse.click(p.x, p.y);
}

async function clickMenu(page: Page, label: string): Promise<boolean> {
  const target = await page.evaluate((lbl) => {
    const rects = (
      window as unknown as {
        __bats: { menuRects(): Array<{ label: string; x: number; y: number; w: number; h: number }> | null };
      }
    ).__bats.menuRects();
    if (!rects) return null;
    const hit = rects.find((r) => r.label === lbl);
    return hit ? { x: hit.x + hit.w / 2, y: hit.y + hit.h / 2 } : null;
  }, label);
  if (!target) return false;
  await page.mouse.click(target.x, target.y);
  return true;
}

const HELP = [
  'commands:',
  '  state                 turn / player / funds / unit counts',
  '  units                 list every unit',
  '  unit <id>             show one unit',
  '  click <x> <y>         real click at a tile centre',
  '  menu <label>          click a canvas menu entry (e.g. Wait, Attack, Infantry)',
  '  endturn               click End Turn, then await idle',
  '  idle                  await the game settling',
  '  shot <path>           screenshot to a PNG path',
  '  eval <js>             page.evaluate raw JS and print the result',
  '  save <path>           write getState() JSON to a file',
  '  load <path>           setState() from a JSON file',
  '  help | quit',
].join('\n');

async function runCommand(page: Page, line: string): Promise<boolean> {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) return true;
  try {
    switch (cmd) {
      case 'state':
        console.log(await summariseState(page));
        break;
      case 'units': {
        const s = await bats<StateLite>(page, 'getState()');
        for (const u of Object.values(s.units)) {
          console.log(`${u.id}  ${u.type} P${u.owner + 1} @(${u.pos.x},${u.pos.y}) hp=${u.hp}${u.hasActed ? ' acted' : ''}`);
        }
        break;
      }
      case 'unit': {
        const id = rest[0];
        const s = await bats<StateLite>(page, 'getState()');
        const u = id ? s.units[id] : undefined;
        console.log(u ? JSON.stringify(u) : `no unit "${id ?? ''}"`);
        break;
      }
      case 'click': {
        const x = Number(rest[0]);
        const y = Number(rest[1]);
        if (Number.isNaN(x) || Number.isNaN(y)) { console.log('usage: click <x> <y>'); break; }
        await clickTile(page, x, y);
        console.log(`clicked (${x},${y}) → input ${(await bats<{ kind: string }>(page, 'input.getInputState()')).kind}`);
        break;
      }
      case 'menu': {
        const label = rest.join(' ');
        const ok = await clickMenu(page, label);
        console.log(ok ? `clicked menu "${label}"` : `no open menu entry "${label}"`);
        break;
      }
      case 'endturn':
        await page.click('[data-action="end-turn"]').catch(() => console.log('End Turn button not clickable'));
        await awaitIdle(page).catch(() => console.log('(idle wait timed out)'));
        console.log(await summariseState(page));
        break;
      case 'idle':
        await awaitIdle(page).catch(() => console.log('(idle wait timed out)'));
        console.log('idle');
        break;
      case 'shot': {
        const out = rest[0];
        if (!out) { console.log('usage: shot <path>'); break; }
        await page.screenshot({ path: resolve(out) as `${string}.png` });
        console.log(`wrote ${resolve(out)}`);
        break;
      }
      case 'eval': {
        const js = line.slice(line.indexOf('eval') + 4).trim();
        const result = await page.evaluate((expr) => {
          const value = new Function(`return (${expr});`)() as unknown;
          try { return JSON.stringify(value); } catch { return String(value); }
        }, js);
        console.log(result);
        break;
      }
      case 'save': {
        const out = rest[0];
        if (!out) { console.log('usage: save <path>'); break; }
        const s = await bats<unknown>(page, 'getState()');
        await writeFile(resolve(out), JSON.stringify(s, null, 2));
        console.log(`saved ${resolve(out)}`);
        break;
      }
      case 'load': {
        const inPath = rest[0];
        if (!inPath) { console.log('usage: load <path>'); break; }
        const json = await readFile(resolve(inPath), 'utf8');
        await page.evaluate((raw) => {
          const s = JSON.parse(raw) as unknown;
          (window as unknown as { __bats: { setState(v: unknown): void } }).__bats.setState(s);
        }, json);
        console.log(await summariseState(page));
        break;
      }
      case 'help':
        console.log(HELP);
        break;
      case 'quit':
      case 'exit':
        return false;
      default:
        console.log(`unknown command "${cmd}" — try help`);
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs();
  let vite: ViteHandle | undefined;
  let browser: Browser | undefined;
  try {
    let url = args.url;
    if (!url) {
      vite = await startVite();
      url = gameUrl(vite.port, {
        ...(args.map !== undefined ? { map: args.map } : {}),
        ...(args.p0 !== undefined ? { p0: args.p0 } : {}),
        ...(args.p1 !== undefined ? { p1: args.p1 } : {}),
        ...(args.fog !== undefined ? { fog: args.fog } : {}),
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
      });
    }
    browser = await launchBrowser({ headless: !args.headful });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    page.on('console', (msg) => process.stdout.write(`[page:${msg.type()}] ${msg.text()}\n`));
    page.on('pageerror', (err) => process.stdout.write(`[page:error] ${err.message}\n`));
    process.stderr.write(`[drive] opening ${url}\n`);
    await openGame(page, url);
    console.log(await summariseState(page));
    console.log('type "help" for commands');

    // Batch script first (if any).
    if (args.script) {
      const text = await readFile(args.script, 'utf8');
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        console.log(`> ${line}`);
        const keepGoing = await runCommand(page, line);
        if (!keepGoing) { args.exit = true; break; }
      }
    }
    if (args.exit) return;

    // Interactive loop.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'drive> ' });
    rl.prompt();
    await new Promise<void>((resolveLoop) => {
      rl.on('line', (line) => {
        void runCommand(page, line).then((keepGoing) => {
          if (!keepGoing) { rl.close(); return; }
          rl.prompt();
        });
      });
      rl.on('close', () => resolveLoop());
    });
  } finally {
    if (browser) await browser.close();
    if (vite) await vite.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
