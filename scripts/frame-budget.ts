// Headless frame-time benchmark. Drives a Vite-served instance of the game
// and samples `requestAnimationFrame` deltas for a fixed window, then reports
// p50 / p95 / p99 in milliseconds.
//
// Usage:
//   npm run frame-budget -- --map=armada --duration-ms=10000
//
// Acceptance bar (from plans/visual-polish.md): p95 ≤ 16 ms, p99 ≤ 24 ms.

import type { Browser } from 'puppeteer';
import {
  startVite,
  launchBrowser,
  gameUrl,
  openGame,
  type ViteHandle,
} from './lib/browser-harness';

type Args = {
  map: string;
  port: number;
  durationMs: number;
  width: number;
  height: number;
};

function parseArgs(): Args {
  const out: Args = { map: 'armada', port: 5181, durationMs: 10_000, width: 1280, height: 900 };
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) continue;
    const [k, v] = [m[1]!, m[2]!];
    if (k === 'map') out.map = v;
    else if (k === 'port') out.port = Number(v);
    else if (k === 'duration-ms') out.durationMs = Number(v);
    else if (k === 'width') out.width = Number(v);
    else if (k === 'height') out.height = Number(v);
  }
  return out;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const args = parseArgs();
  let vite: ViteHandle | undefined;
  let browser: Browser | undefined;
  try {
    vite = await startVite(args.port);
    browser = await launchBrowser({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: args.width, height: args.height });
    // No debug hook needed — we only sample rAF deltas, so keep the page as
    // close to production as possible (debug:false).
    await openGame(page, gameUrl(vite.port, { map: args.map, debug: false }));
    // Settle: first paint + async asset decode.
    await new Promise((r) => setTimeout(r, 800));
    const samples = await page.evaluate((durationMs) => {
      return new Promise<number[]>((resolve) => {
        const out: number[] = [];
        let last = performance.now();
        const start = last;
        // NB: the rAF callback is kept anonymous (pushed into `slot`, called by
        // reference) on purpose. tsx compiles this file with esbuild keepNames,
        // which injects a module-scope `__name(...)` helper call into any *named*
        // function — but puppeteer serializes only the callback body to the
        // browser, without that helper, so a named inner function throws
        // "__name is not defined". An anonymous arg dodges the wrap entirely.
        const slot: Array<(now: number) => void> = [];
        slot.push((now: number): void => {
          out.push(now - last);
          last = now;
          if (now - start >= durationMs) resolve(out);
          else requestAnimationFrame(slot[0]!);
        });
        requestAnimationFrame(slot[0]!);
      });
    }, args.durationMs);
    // Drop the first 5 samples (warm-up).
    const trimmed = samples.slice(5);
    const sorted = [...trimmed].sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    const p99 = percentile(sorted, 0.99);
    const mean = trimmed.reduce((s, n) => s + n, 0) / trimmed.length;
    const max = sorted[sorted.length - 1] ?? 0;
    process.stdout.write(
      `map=${args.map} samples=${trimmed.length} ` +
      `mean=${mean.toFixed(2)}ms p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms ` +
      `p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms\n`,
    );
    const ok = p95 <= 16 && p99 <= 24;
    process.stdout.write(`acceptance: ${ok ? 'PASS' : 'FAIL'} (p95 ≤ 16, p99 ≤ 24)\n`);
    if (!ok) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (vite) await vite.stop();
  }
}

void main();
