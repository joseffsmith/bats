// Screenshot the unit-sprite contact sheet (`?sheet=1`).
//
// Thin wrapper over the shared browser harness: spawn an isolated Vite server,
// open the sheet page, wait for it to signal `window.__sheetReady`, and write a
// full-page PNG. This is the art-review deliverable — regenerate it after any
// change to the pixel-art grids or the bake pipeline.
//
// Usage:
//   npm run sprites -- --out=/tmp/contact-sheet.png
//
// Flags:
//   --out=PATH   PNG output path (default: scratch dir alongside this repo)
//   --port=N     preferred dev-server port (default 5179; auto-retries upward)
//   --scale=N    deviceScaleFactor for a crisper capture (default 1)

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Browser } from 'puppeteer';
import { startVite, launchBrowser, type ViteHandle } from './lib/browser-harness';

type Args = { out: string; port: number; scale: number };

function parseArgs(): Args {
  const out: Args = { out: '/tmp/sprite-contact-sheet.png', port: 5179, scale: 1 };
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'out') out.out = v!;
    else if (k === 'port') out.port = Number(v);
    else if (k === 'scale') out.scale = Number(v);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  await mkdir(dirname(resolve(args.out)), { recursive: true });

  const vite: ViteHandle = await startVite(args.port);
  let browser: Browser | undefined;
  try {
    browser = await launchBrowser({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 2100, deviceScaleFactor: args.scale });
    const url = `http://localhost:${vite.port}/?sheet=1`;
    process.stderr.write(`[sprites] navigating ${url}\n`);
    await page.goto(url, { waitUntil: 'load' });
    // The sheet flips this flag once every sprite is painted.
    await page.waitForFunction(
      () => (window as unknown as { __sheetReady?: boolean }).__sheetReady === true,
      { timeout: 15_000 },
    );
    const outPath = resolve(args.out);
    await page.screenshot({ path: outPath as `${string}.png`, fullPage: true });
    process.stdout.write(`${outPath}\n`);
  } finally {
    if (browser) await browser.close();
    await vite.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
