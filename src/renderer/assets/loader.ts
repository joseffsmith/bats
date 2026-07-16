// Async loader for terrain tile PNGs.
//
// Unit sprites are no longer loaded here — they're generated in-repo from the
// hand-authored pixel-art grids (see ../sprites.ts + ./pixel-art/). This loader
// now only decodes the terrain tiles, which stay PNG until Phase 3B. The raw
// unit PNGs under ./raw/ are dead (kept on disk for Phase 3B's final deletion)
// and intentionally not globbed.
//
// Vite resolves `import.meta.glob` at build time, giving each PNG a hashed URL
// the browser can fetch in parallel. The loader awaits all decodes and returns
// a map keyed by TerrainType so `createTerrainCache` can index it directly.
//
// Under JSDOM (tests) `Image` and `URL.createObjectURL` may be missing or
// non-functional; the loader detects that and resolves to an empty map so the
// terrain cache falls back to procedural tiles.

import type { TerrainType } from '../../engine/core/types';

const TERRAIN_PNG_URLS = import.meta.glob<string>('./terrain-raw/*.png', {
  query: '?url',
  import: 'default',
  eager: false,
});

export type TerrainImages = Map<TerrainType, CanvasImageSource>;

export type LoadedAssets = {
  terrain: TerrainImages;
};

function parseTerrainKey(path: string): TerrainType | null {
  const m = path.match(/\/([a-z]+)\.png$/);
  if (!m) return null;
  return m[1] as TerrainType;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`failed to load ${url}: ${String(e)}`));
    img.src = url;
  });
}

async function loadGlob<K>(
  urls: Record<string, () => Promise<string>>,
  parseKey: (path: string) => K | null,
): Promise<Map<K, CanvasImageSource>> {
  const out = new Map<K, CanvasImageSource>();
  if (typeof Image === 'undefined' || typeof document === 'undefined') return out;
  await Promise.all(
    Object.entries(urls).map(async ([path, loader]) => {
      const key = parseKey(path);
      if (key === null) return;
      try {
        const url = await loader();
        const img = await loadImage(url);
        out.set(key, img);
      } catch {
        // Individual failures are tolerated — consumer falls back to procedural.
      }
    }),
  );
  return out;
}

export async function loadAssets(): Promise<LoadedAssets> {
  const terrain = await loadGlob(TERRAIN_PNG_URLS, parseTerrainKey);
  return { terrain };
}
