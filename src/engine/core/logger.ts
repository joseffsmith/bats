// Tiny structured logger.
//
// Usage:
//   import { log, setLogEnabled } from './logger';
//   log('engine', 'action applied', { type: 'MOVE', unitId: 'u1' });
//   setLogEnabled('render', true);
//
// Each call emits a single line to the console prefixed with an ISO timestamp
// and the category, e.g.:
//   [2026-05-12T10:23:45.123Z][engine] action applied { type: 'MOVE', unitId: 'u1' }

export type LogCategory = 'engine' | 'ai' | 'ai-trace' | 'render' | 'match';

const enabled: Record<LogCategory, boolean> = {
  engine: true,
  ai: true,
  // `ai-trace` fires once per candidate evaluation inside the utility AI —
  // it is invaluable when tuning weights but pure noise in production runs.
  // Default DISABLED.
  'ai-trace': false,
  render: false,
  match: true,
};

export function setLogEnabled(category: LogCategory, value: boolean): void {
  enabled[category] = value;
}

export function isLogEnabled(category: LogCategory): boolean {
  return enabled[category];
}

export function log(category: LogCategory, ...args: unknown[]): void {
  if (!enabled[category]) return;
  const ts = new Date().toISOString();
  console.log(`[${ts}][${category}]`, ...args);
}
