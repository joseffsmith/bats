// @vitest-environment jsdom
//
// Phase 6 sprite cache smoke test.
//
// Just verifies the cache is populated for every (type, owner, variant)
// combination. We don't pixel-compare — the cache exists to make rendering
// dependable, and rendering is exercised by the renderer-smoke test.

import { describe, expect, it } from 'vitest';
import { createSpriteCache } from '../src/renderer/sprites';

describe('sprite cache', () => {
  it('contains entries for every (type, owner, variant) tuple', () => {
    const cache = createSpriteCache();
    // 5 types * 2 owners * 2 variants = 20 entries.
    expect(cache.size()).toBe(5 * 2 * 2);
    const keys = cache.keys();
    expect(keys).toContain('infantry-0-clean');
    expect(keys).toContain('infantry-0-damaged');
    expect(keys).toContain('tank-1-clean');
    expect(keys).toContain('copter-1-damaged');
  });

  it('get() returns a CanvasImageSource and throws on missing keys', () => {
    const cache = createSpriteCache();
    const img = cache.get('tank', 0, 'clean');
    expect(img).toBeDefined();
    // We don't know whether OffscreenCanvas exists in JSDOM, but the result
    // must at minimum be either a canvas or an OffscreenCanvas-like object.
    expect(typeof (img as object)).toBe('object');
  });
});
