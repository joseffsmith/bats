import { defineConfig } from 'vitest/config';

// Browser end-to-end suite: real Chromium via puppeteer, driving the live Vite
// app through the `window.__bats` hook. Deliberately serial (`fileParallelism:
// false`) — one Chromium at a time is our first line of flake defence, since
// the specs share a single dev server and drive real mouse/keyboard input.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    environment: 'node',
    // Browser boots + AI turns are slow relative to unit tests.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One browser at a time — see note above.
    fileParallelism: false,
    // A single retry in CI absorbs the rare genuine flake (a dropped CDP frame)
    // without masking real regressions; locally we want failures to be sticky.
    retry: process.env.CI ? 1 : 0,
    // Starts ONE shared Vite server and publishes its port via `provide`.
    globalSetup: './e2e/global-setup.ts',
  },
});
