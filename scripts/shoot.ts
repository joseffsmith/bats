// Capture a screenshot of the game UI for review.
//
// Spawns its own Vite dev server on a private port, opens the page in headless
// Chromium via puppeteer, optionally steps forward N turns (clicking End Turn
// and waiting for AI to settle), and writes a PNG to disk. Used by agents
// (or you, manually) to inspect the live UI without leaving the terminal.
//
// Usage:
//   npm run shoot -- --map=highlands --out=/tmp/start.png
//   npm run shoot -- --map=armada --p0=balanced --p1=aggressor --turn=10 --out=/tmp/mid.png
//   npm run shoot -- --url='http://localhost:5173/?editor=1' --out=/tmp/editor.png
//
// Flags:
//   --out=PATH        (required) PNG output path
//   --map=NAME        map id (duel, crossroads, island_hop, canyon, highlands, armada)
//   --p0=NAME         player 0 AI persona (or "human", "random", "utility")
//   --p1=NAME         player 1 AI persona
//   --turn=N          auto-click End Turn N times after load (AI plays its turns)
//   --width=W         viewport width (default 1280)
//   --height=H        viewport height (default 900)
//   --url=URL         override constructed URL entirely; skip dev-server spawn
//   --port=N          dev-server port (default 5179)
//   --wait-ms=N       extra settle delay before screenshot (default 400)

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser } from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));

type Args = {
  out: string;
  map?: string;
  p0?: string;
  p1?: string;
  turn?: number;
  width: number;
  height: number;
  url?: string;
  port: number;
  waitMs: number;
  fog?: string;
  view?: string;
  slowmo?: number;
};

function parseArgs(): Args {
  const out: Partial<Args> = { width: 1280, height: 900, port: 5179, waitMs: 400 };
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) continue;
    const k = m[1] as string;
    const v = m[2] as string;
    if (k === 'out') out.out = v;
    else if (k === 'map') out.map = v;
    else if (k === 'p0') out.p0 = v;
    else if (k === 'p1') out.p1 = v;
    else if (k === 'turn') out.turn = Number(v);
    else if (k === 'width') out.width = Number(v);
    else if (k === 'height') out.height = Number(v);
    else if (k === 'url') out.url = v;
    else if (k === 'port') out.port = Number(v);
    else if (k === 'wait-ms') out.waitMs = Number(v);
    else if (k === 'fog') out.fog = v;
    else if (k === 'view') out.view = v;
    else if (k === 'slowmo') out.slowmo = Number(v);
  }
  if (!out.out) {
    console.error('--out=PATH is required');
    process.exit(1);
  }
  return out as Args;
}

async function waitForServer(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/`);
      if (r.ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Vite dev server did not start on :${port} within ${timeoutMs}ms`);
}

function spawnVite(port: number): ChildProcess {
  const proc = spawn('node_modules/.bin/vite', ['--port', String(port), '--strictPort'], {
    cwd: resolve(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (b) => process.stderr.write(`[vite] ${b}`));
  proc.stderr?.on('data', (b) => process.stderr.write(`[vite!] ${b}`));
  return proc;
}

function buildUrl(args: Args): string {
  if (args.url) return args.url;
  const u = new URL(`http://localhost:${args.port}/`);
  if (args.map) u.searchParams.set('map', args.map);
  if (args.p0) u.searchParams.set('p0', args.p0);
  if (args.p1) u.searchParams.set('p1', args.p1);
  if (args.fog) u.searchParams.set('fog', args.fog);
  if (args.view) u.searchParams.set('view', args.view);
  if (args.slowmo) u.searchParams.set('slowmo', String(args.slowmo));
  return u.toString();
}

async function stepTurns(page: import('puppeteer').Page, turns: number): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    // The End Turn button is the only button with that exact text in the DOM.
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const target = btns.find((b) => /end turn/i.test(b.textContent ?? ''));
      if (!target) return false;
      target.click();
      return true;
    });
    if (!clicked) throw new Error(`End Turn button not found on iteration ${i}`);
    // Let AI animation queue drain. The pauseMs default in main.ts is 250ms;
    // give it generously more so multi-action AI turns finish.
    await new Promise((r) => setTimeout(r, 1200));
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  await mkdir(dirname(resolve(args.out)), { recursive: true });

  let vite: ChildProcess | undefined;
  if (!args.url) {
    vite = spawnVite(args.port);
    await waitForServer(args.port, 15_000);
  }

  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: args.width, height: args.height });
    const url = buildUrl(args);
    process.stderr.write(`[shoot] navigating ${url}\n`);
    // Use 'load' (DOM + module imports complete) rather than 'networkidle0' —
    // Vite's HMR keeps a WebSocket open, so networkidle0 can hang.
    await page.goto(url, { waitUntil: 'load' });
    // Page-load settle (canvas first paint).
    await new Promise((r) => setTimeout(r, args.waitMs));
    if (args.turn && args.turn > 0) {
      process.stderr.write(`[shoot] stepping ${args.turn} turn(s)\n`);
      await stepTurns(page, args.turn);
      await new Promise((r) => setTimeout(r, args.waitMs));
    }
    const outPath = resolve(args.out);
    await page.screenshot({ path: outPath as `${string}.png`, fullPage: false });
    process.stdout.write(`${outPath}\n`);
  } finally {
    if (browser) await browser.close();
    if (vite && !vite.killed) {
      vite.kill('SIGTERM');
      // Give it a moment to die cleanly.
      await new Promise((r) => setTimeout(r, 200));
      if (!vite.killed) vite.kill('SIGKILL');
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
