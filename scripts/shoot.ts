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
//   --mobile=1|0      force the mobile (camera + full-bleed) board on/off. A
//                     narrow --width alone does NOT trigger it: the page reads
//                     `(pointer: coarse)`, which headless Chromium won't report
//                     without touch emulation. Pair with --width=390 --height=844.
//   --campaign=...    campaign entry point (passed straight through)

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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
  scene?: string;
  mobile?: string;
  campaign?: string;
};

/**
 * Named scene presets — URL params + turn counts + settle timing baked in so
 * polish screenshots are reproducible. Pass `--scene=NAME` to apply; any
 * explicit flag the user passes still overrides the preset.
 */
const SCENES: Record<string, Partial<Args>> = {
  'projectile-arc':    { map: 'armada',    p0: 'balanced', p1: 'aggressor', turn: 12, slowmo: 10, waitMs: 1500 },
  'tank-duel-impact':  { map: 'duel',      p0: 'balanced', p1: 'balanced',  turn: 8,  slowmo: 5,  waitMs: 1500 },
  'capture-flash':     { map: 'duel',      p0: 'balanced', p1: 'balanced',  turn: 15, slowmo: 8,  waitMs: 1500 },
  'damage-numbers':    { map: 'highlands', p0: 'balanced', p1: 'balanced',  turn: 14, waitMs: 1500 },
  'armada-start':      { map: 'armada',    turn: 0 },
  'duel-mid':          { map: 'duel',      p0: 'balanced', p1: 'balanced',  turn: 14 },
  'island-hop-mid':    { map: 'island_hop', p0: 'balanced', p1: 'balanced', turn: 15 },
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
    else if (k === 'scene') out.scene = v;
    else if (k === 'mobile') out.mobile = v;
    else if (k === 'campaign') out.campaign = v;
  }
  if (!out.out) {
    console.error('--out=PATH is required');
    process.exit(1);
  }
  // Scene presets fill in any field the caller didn't already specify.
  if (out.scene) {
    const preset = SCENES[out.scene];
    if (!preset) {
      console.error(`unknown --scene=${out.scene}; valid: ${Object.keys(SCENES).join(', ')}`);
      process.exit(1);
    }
    for (const [k, v] of Object.entries(preset)) {
      if ((out as Record<string, unknown>)[k] === undefined) {
        (out as Record<string, unknown>)[k] = v;
      }
    }
  }
  return out as Args;
}

function buildUrl(args: Args, port: number): string {
  // Raw --url passthrough is verbatim (no debug injection): the caller owns it.
  if (args.url) return args.url;
  // Constructed URLs default debug=1 on (via gameUrl) so stepTurns can idle-await
  // instead of sleeping. Conditional spreads keep exactOptionalPropertyTypes
  // happy (no `map: undefined`).
  return gameUrl(port, {
    ...(args.map !== undefined ? { map: args.map } : {}),
    ...(args.p0 !== undefined ? { p0: args.p0 } : {}),
    ...(args.p1 !== undefined ? { p1: args.p1 } : {}),
    ...(args.fog !== undefined ? { fog: args.fog } : {}),
    ...(args.view !== undefined ? { view: args.view } : {}),
    ...(args.slowmo !== undefined ? { slowmo: args.slowmo } : {}),
    ...(args.mobile !== undefined ? { mobile: args.mobile } : {}),
    ...(args.campaign !== undefined ? { campaign: args.campaign } : {}),
  });
}

/** Click the End Turn button (the only DOM button with that text). */
async function clickEndTurn(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const target = btns.find((b) => /end turn/i.test(b.textContent ?? ''));
    if (!target) return false;
    target.click();
    return true;
  });
}

async function stepTurns(page: Page, turns: number, url: string): Promise<void> {
  // Raw --url without debug=1 has no __bats hook to poll, so fall back to the
  // old fixed settle (main.ts's pauseMs default is 250ms; give multi-action AI
  // turns generously more).
  const hasHook = /[?&]debug=1(?:&|$)/.test(url);
  for (let i = 0; i < turns; i += 1) {
    if (hasHook) {
      // A "step" = advance the turn counter by one. Robust for both hot-seat-vs-
      // AI (the click ends the human turn) AND AI-vs-AI (the click is an inert
      // no-op while inputLocked, but the AI advances the turn itself) — and it
      // sidesteps the transient ~1-frame idle window right after END_TURN,
      // before the next player's AI has planned. Then idle-await drains the
      // freshly-ended turn's animations so the screenshot isn't mid-flight.
      const turnBefore = await page.evaluate(
        () =>
          (window as unknown as { __bats: { getState(): { turn: number } } }).__bats.getState()
            .turn,
      );
      if (!(await clickEndTurn(page))) {
        throw new Error(`End Turn button not found on iteration ${i}`);
      }
      await page.waitForFunction(
        (before: number) => {
          const b = (
            window as unknown as {
              __bats?: { getState(): { turn: number; winner: number | null } };
            }
          ).__bats;
          if (!b) return false;
          const s = b.getState();
          return s.turn > before || s.winner !== null;
        },
        { timeout: 20_000, polling: 100 },
        turnBefore,
      );
      // Best-effort settle: an unbroken AI-vs-AI churn never holds a stable idle
      // between turns, so don't let a settle timeout fail the shot — the turn
      // already advanced. The hot-seat-vs-AI path settles cleanly well inside
      // the window.
      await awaitIdle(page, 8_000).catch(() => {});
    } else {
      if (!(await clickEndTurn(page))) {
        throw new Error(`End Turn button not found on iteration ${i}`);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  await mkdir(dirname(resolve(args.out)), { recursive: true });

  let vite: ViteHandle | undefined;
  let port = args.port;
  if (!args.url) {
    vite = await startVite(args.port);
    port = vite.port;
  }

  let browser: Browser | undefined;
  try {
    browser = await launchBrowser({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: args.width, height: args.height });
    const url = buildUrl(args, port);
    process.stderr.write(`[shoot] navigating ${url}\n`);
    await openGame(page, url);
    // Page-load settle (canvas first paint).
    await new Promise((r) => setTimeout(r, args.waitMs));
    if (args.turn && args.turn > 0) {
      process.stderr.write(`[shoot] stepping ${args.turn} turn(s)\n`);
      await stepTurns(page, args.turn, url);
      await new Promise((r) => setTimeout(r, args.waitMs));
    }
    const outPath = resolve(args.out);
    await page.screenshot({ path: outPath as `${string}.png`, fullPage: false });
    process.stdout.write(`${outPath}\n`);
  } finally {
    if (browser) await browser.close();
    if (vite) await vite.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
