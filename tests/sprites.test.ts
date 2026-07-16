// @vitest-environment jsdom
//
// Sprite cache smoke test (post pixel-art redo).
//
// The cache now bakes the in-repo pixel-art grids — there are no image inputs.
// Under jsdom without a canvas backend the bake can't get a 2d context, so every
// entry is the 1×1 stub host; the assertions below are written to hold in BOTH
// worlds (real canvas → data URLs + distinct damaged art; stub → null URLs).

import { describe, expect, it } from 'vitest';
import { createSpriteCache, type SpriteVariant } from '../src/renderer/sprites';
import type { PlayerId, UnitType } from '../src/engine/core/types';

const TYPES: UnitType[] = [
  'infantry', 'recon', 'tank', 'artillery', 'copter', 'transport',
  'fighter', 'bomber', 'battleship', 'cruiser', 'aatank', 'lander',
  'submarine', 'carrier',
];
const OWNERS: PlayerId[] = [0, 1];
const VARIANTS: SpriteVariant[] = ['clean', 'damaged'];

describe('sprite cache', () => {
  it('builds without any image inputs and covers every combo', () => {
    const cache = createSpriteCache();
    // 14 types * 2 owners * 2 variants = 56 entries.
    expect(cache.size()).toBe(14 * 2 * 2);
    for (const type of TYPES) {
      for (const owner of OWNERS) {
        for (const variant of VARIANTS) {
          const img = cache.get(type, owner, variant);
          expect(img, `${type}-${owner}-${variant}`).toBeDefined();
          expect(typeof (img as object)).toBe('object');
        }
      }
    }
  });

  it('exposes the expected keys', () => {
    const cache = createSpriteCache();
    const keys = cache.keys();
    expect(keys).toContain('infantry-0-clean');
    expect(keys).toContain('tank-1-damaged');
    expect(keys).toContain('carrier-0-clean');
    expect(keys).toContain('submarine-1-damaged');
  });

  it('throws on an unknown key', () => {
    const cache = createSpriteCache();
    // @ts-expect-error — deliberately bogus type to exercise the guard.
    expect(() => cache.get('mech', 0, 'clean')).toThrow(/sprite missing/);
  });

  it('toDataURL is a PNG data URL in real-canvas envs, null in stub mode', () => {
    const cache = createSpriteCache();
    const url = cache.toDataURL('tank', 0);
    if (url === null) {
      // Stub mode (jsdom w/o canvas): every entry is the shared 1×1 host, so
      // clean and damaged are necessarily identical — nothing more to assert.
      expect(cache.toDataURL('tank', 1)).toBeNull();
      return;
    }
    expect(url.startsWith('data:image/png')).toBe(true);
    // With a real canvas, verify the damage pass actually changed pixels by
    // reading both baked sources back and comparing their image data.
    const pixels = (src: unknown): Uint8ClampedArray | null => {
      const c = src as HTMLCanvasElement;
      const cctx = c.getContext?.('2d');
      return cctx ? cctx.getImageData(0, 0, c.width, c.height).data : null;
    };
    const clean = pixels(cache.get('tank', 0, 'clean'));
    const damaged = pixels(cache.get('tank', 0, 'damaged'));
    expect(clean && damaged && clean.length === damaged.length).toBeTruthy();
    expect(Buffer.from(clean!).equals(Buffer.from(damaged!))).toBe(false);
  });
});
