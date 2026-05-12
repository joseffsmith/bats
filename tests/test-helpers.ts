// Test helpers shared by Phase 1 smoke tests. Disables engine logging for a
// quieter run; individual tests can re-enable it if they want to debug.

import { setLogEnabled } from '../src/engine/core/logger';
import { createInitialState } from '../src/engine/core/initial-state';
import type { InitialMapSpec } from '../src/engine/core/initial-state';

setLogEnabled('engine', false);
setLogEnabled('ai', false);
setLogEnabled('render', false);

export function makeState(spec: InitialMapSpec): ReturnType<typeof createInitialState> {
  return createInitialState(spec);
}
