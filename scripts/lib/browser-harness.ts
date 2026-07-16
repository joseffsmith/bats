// Shared Vite + Puppeteer plumbing for the headless scripts (shoot, frame-budget)
// and — later — the Phase 1 e2e suite. Extracted from the copy-pasted spawn /
// wait / launch blocks those scripts grew independently.
//
// The one non-obvious piece is `awaitIdle`: rather than sleeping a fixed number
// of milliseconds and hoping the AI turn finished, drivers poll the page's
// `window.__bats.idle()` (installed by the `?debug=1` hook) until the animation
// queue and AI driver are both quiet. That requires the page be opened with
// `debug=1` — `gameUrl` defaults it on.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo root: this file lives at scripts/lib/, so climb two levels. */
const REPO_ROOT = resolve(__dirname, '..', '..');

/** Upper bound for the port-scan when the preferred port is busy. */
const MAX_PORT = 5199;
/** Per-port grace window before we give up and try the next port. */
const PER_PORT_TIMEOUT_MS = 10_000;

export type ViteHandle = {
  /** Port the server actually bound to (may differ from the preferred one). */
  port: number;
  /** SIGTERM, then SIGKILL after a short grace period. */
  stop(): Promise<void>;
};

function spawnVite(port: number): ChildProcess {
  const proc = spawn('node_modules/.bin/vite', ['--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (b) => process.stderr.write(`[vite] ${b}`));
  proc.stderr?.on('data', (b) => process.stderr.write(`[vite!] ${b}`));
  return proc;
}

/** SIGTERM then SIGKILL-after-grace. Mirrors shoot.ts's old finally block. */
async function terminate(proc: ChildProcess): Promise<void> {
  if (proc.killed) return;
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  if (!proc.killed) proc.kill('SIGKILL');
}

/**
 * Poll `http://localhost:port/` until it answers 200 or `timeoutMs` elapses.
 * Standalone export (the scripts used to inline this); `startVite` has its own
 * exit-aware variant so a `--strictPort` bail is detected immediately.
 */
export async function waitForServer(port: number, timeoutMs = 15_000): Promise<void> {
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

/** Try one port: resolve the live process, or null if the port was busy. */
async function attemptPort(port: number): Promise<ChildProcess | null> {
  const proc = spawnVite(port);
  // With `--strictPort`, vite exits immediately if the port is taken; treat an
  // early exit as "busy, try the next one".
  let exited = false;
  const onExit = (): void => {
    exited = true;
  };
  proc.once('exit', onExit);

  const deadline = Date.now() + PER_PORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) return null;
    try {
      const r = await fetch(`http://localhost:${port}/`);
      if (r.ok) {
        proc.off('exit', onExit);
        return proc;
      }
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Alive but never answered — clean up and let the caller try the next port.
  proc.off('exit', onExit);
  await terminate(proc);
  return null;
}

/**
 * Spawn a Vite dev server, retrying successive ports if the preferred one is
 * busy (so parallel script runs don't collide). Resolves once the server
 * answers.
 */
export async function startVite(preferredPort = 5179): Promise<ViteHandle> {
  for (let port = preferredPort; port <= MAX_PORT; port++) {
    const proc = await attemptPort(port);
    if (proc) {
      return {
        port,
        stop: () => terminate(proc),
      };
    }
    process.stderr.write(`[harness] port ${port} busy, trying ${port + 1}\n`);
  }
  throw new Error(`no free port for vite in [${preferredPort}, ${MAX_PORT}]`);
}

export function launchBrowser(opts: { headless?: boolean } = {}): Promise<Browser> {
  return puppeteer.launch({
    headless: opts.headless ?? true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // The three throttling/backgrounding flags keep requestAnimationFrame
      // firing in an occluded/backgrounded headless page. Without them Chromium
      // throttles rAF (down to ~1Hz, or pauses it) when the page isn't visibly
      // foregrounded — which stalls aiDriver.tick() (driven off the render loop)
      // and makes awaitIdle() hang waiting for an AI turn that never advances.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
}

export type GameUrlParams = {
  map?: string;
  p0?: string;
  p1?: string;
  fog?: string;
  view?: string;
  slowmo?: number;
  seed?: number;
  /** Install the window.__bats hook. Defaults to true (enables idle-await). */
  debug?: boolean;
};

/** Build a game URL. Mirrors shoot.ts's buildUrl, plus seed + debug. */
export function gameUrl(port: number, params: GameUrlParams = {}): string {
  const u = new URL(`http://localhost:${port}/`);
  if (params.map) u.searchParams.set('map', params.map);
  if (params.p0) u.searchParams.set('p0', params.p0);
  if (params.p1) u.searchParams.set('p1', params.p1);
  if (params.fog) u.searchParams.set('fog', params.fog);
  if (params.view) u.searchParams.set('view', params.view);
  if (params.slowmo) u.searchParams.set('slowmo', String(params.slowmo));
  if (params.seed !== undefined) u.searchParams.set('seed', String(params.seed));
  // Default debug ON so callers get the __bats hook (and idle-await) for free.
  if (params.debug !== false) u.searchParams.set('debug', '1');
  return u.toString();
}

/** Navigate and, for a debug URL, wait until the __bats hook is installed. */
export async function openGame(page: Page, url: string): Promise<void> {
  // 'load' (DOM + module imports complete) rather than 'networkidle0' — Vite's
  // HMR keeps a WebSocket open, so networkidle0 can hang.
  await page.goto(url, { waitUntil: 'load' });
  if (/[?&]debug=1(?:&|$)/.test(url)) {
    await page.waitForFunction(
      () => !!(window as unknown as { __bats?: unknown }).__bats,
    );
  }
}

/**
 * Wait until the game reports idle (no animations, no AI plan in flight). On
 * timeout, if `artifactsDir` is given, dump the live GameState and a screenshot
 * there before rethrowing so a stuck run leaves something to inspect.
 *
 * Caveat: this is a point-in-time "is it idle now" wait. There is a ~1-frame
 * window right after an action that triggers async work (e.g. END_TURN handing
 * off to the AI) where idle() is momentarily true before the driver's next
 * rAF tick plans the turn. A caller that just triggered such work should first
 * gate on the work having STARTED (e.g. wait for the turn counter to advance,
 * as stepTurns does) before awaiting idle, or it may return on that blip.
 */
export async function awaitIdle(
  page: Page,
  timeoutMs = 15_000,
  artifactsDir?: string,
): Promise<void> {
  try {
    await page.waitForFunction(
      () =>
        (window as unknown as { __bats?: { idle(): boolean } }).__bats?.idle() === true,
      { timeout: timeoutMs, polling: 100 },
    );
  } catch (err) {
    if (artifactsDir) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      await mkdir(artifactsDir, { recursive: true });
      try {
        const state = await page.evaluate(
          () =>
            (window as unknown as { __bats?: { getState(): unknown } }).__bats?.getState() ??
            null,
        );
        await writeFile(
          resolve(artifactsDir, `${ts}-state.json`),
          JSON.stringify(state, null, 2),
        );
        await page.screenshot({
          path: resolve(artifactsDir, `${ts}-timeout.png`) as `${string}.png`,
        });
      } catch {
        // best-effort artifacts; don't mask the original timeout
      }
    }
    throw err;
  }
}

/** Collect console messages + page errors off a page for post-run assertions. */
export function wireConsoleCapture(page: Page): { errors: string[]; all: string[] } {
  const errors: string[] = [];
  const all: string[] = [];
  page.on('console', (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    all.push(text);
    if (msg.type() === 'error') errors.push(text);
  });
  page.on('pageerror', (err) => {
    const text = `[pageerror] ${err.message}`;
    all.push(text);
    errors.push(text);
  });
  return { errors, all };
}
