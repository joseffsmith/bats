// e2e global setup: bring up ONE Vite dev server for the whole browser suite
// and publish the port it bound to so every worker can build game URLs against
// it. The specs run serially (fileParallelism: false), so a single server with
// no per-file spawn cost is both faster and less flaky than one-per-file.
//
// The running dev server on :5173 (if any) is left untouched — startVite
// port-scans from 5179 upward.

import type { GlobalSetupContext } from 'vitest/node';
import { startVite, type ViteHandle } from '../scripts/lib/browser-harness';

// Make the provided port strongly-typed for `inject('e2ePort')` in helpers.ts.
declare module 'vitest' {
  interface ProvidedContext {
    e2ePort: number;
  }
}

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const vite: ViteHandle = await startVite();
  provide('e2ePort', vite.port);
  process.stderr.write(`[e2e] vite dev server on :${vite.port}\n`);

  return async (): Promise<void> => {
    await vite.stop();
  };
}
