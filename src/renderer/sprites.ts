// Unit sprite cache.
//
// Sprites are PNGs in `assets/raw/`, loaded once at startup by
// `assets/loader.ts` and indexed here by (type, owner, variant). The cache
// preserves the original interface — `canvas.ts` calls `get(...)` and
// `drawImage`s the result — but the source is real pixel art rather than
// procedural primitives.
//
// Variant fallback: only 'clean' art exists today; 'damaged' aliases to
// 'clean' so consumer code in canvas.ts doesn't need to change.
//
// JSDOM safety: if no image map is passed (test path), every cache entry is
// a 1×1 OffscreenCanvas/HTMLCanvasElement stub. `drawImage` of a 1×1 source
// is a no-op visually but exercises the same code paths.

import type { PlayerId, UnitType } from '../engine/core/types';
import type { UnitSpriteImages } from './assets/loader';

/** Side length of the generated sprite, in CSS pixels. */
export const SPRITE_SIZE = 48;

export type SpriteVariant = 'clean' | 'damaged';

export type SpriteCache = {
  get(type: UnitType, owner: PlayerId, variant: SpriteVariant): CanvasImageSource;
  size(): number;
  keys(): string[];
};

function cacheKey(type: UnitType, owner: PlayerId, variant: SpriteVariant): string {
  return `${type}-${owner}-${variant}`;
}

const UNIT_TYPES: ReadonlyArray<UnitType> = [
  'infantry', 'recon', 'tank', 'artillery', 'copter', 'transport',
  'fighter', 'bomber', 'battleship', 'cruiser', 'aatank', 'lander',
  'submarine', 'carrier',
];
const PLAYERS: ReadonlyArray<PlayerId> = [0, 1];
const VARIANTS: ReadonlyArray<SpriteVariant> = ['clean', 'damaged'];

function makeStubHost(): CanvasImageSource {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(1, 1);
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    return c;
  }
  // Last-resort minimal stub for non-DOM hosts.
  return { width: 1, height: 1 } as unknown as CanvasImageSource;
}

export function createSpriteCache(images?: UnitSpriteImages): SpriteCache {
  const map = new Map<string, CanvasImageSource>();
  const stub = makeStubHost();
  for (const type of UNIT_TYPES) {
    for (const owner of PLAYERS) {
      const clean = images?.get(`${type}-${owner}-clean`);
      for (const variant of VARIANTS) {
        // 'damaged' aliases 'clean' until a damaged art pass lands.
        map.set(cacheKey(type, owner, variant), clean ?? stub);
      }
    }
  }
  return {
    get(type, owner, variant) {
      const host = map.get(cacheKey(type, owner, variant));
      if (!host) throw new Error(`sprite missing: ${type}-${owner}-${variant}`);
      return host;
    },
    size() {
      return map.size;
    },
    keys() {
      return Array.from(map.keys());
    },
  };
}
