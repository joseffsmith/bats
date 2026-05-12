import { describe, it, expect } from 'vitest';
import { log, setLogEnabled, isLogEnabled } from '../src/engine/core/logger';

describe('phase 0 smoke', () => {
  it('logger toggles category state', () => {
    setLogEnabled('render', true);
    expect(isLogEnabled('render')).toBe(true);
    setLogEnabled('render', false);
    expect(isLogEnabled('render')).toBe(false);
  });

  it('log() is a no-op for disabled categories', () => {
    setLogEnabled('render', false);
    // Should not throw.
    log('render', 'this should be suppressed');
    expect(true).toBe(true);
  });
});
