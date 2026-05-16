// Async loader for unit sprite PNGs.
//
// Vite resolves `import.meta.glob` at build time, giving each PNG a hashed
// URL the browser can fetch in parallel. The loader awaits all decodes and
// returns a map keyed by `<type>-<player>-clean` so `createSpriteCache` can
// drop the images straight into the existing SpriteCache layout.
//
// Under JSDOM (tests) `Image` and `URL.createObjectURL` may be missing or
// non-functional; the loader detects that and resolves to an empty map so
// `createSpriteCache` falls back to its 1×1 stub hosts.

import type { PlayerId, TerrainType, UnitType } from '../../engine/core/types';

const UNIT_PNG_URLS = import.meta.glob<string>('./raw/*-p[01].png', {
  query: '?url',
  import: 'default',
  eager: false,
});

const TERRAIN_PNG_URLS = import.meta.glob<string>('./terrain-raw/*.png', {
  query: '?url',
  import: 'default',
  eager: false,
});

export type UnitSpriteKey = `${UnitType}-${PlayerId}-clean`;
export type UnitSpriteImages = Map<UnitSpriteKey, CanvasImageSource>;
export type TerrainImages = Map<TerrainType, CanvasImageSource>;

export type LoadedAssets = {
  units: UnitSpriteImages;
  terrain: TerrainImages;
};

function parseUnitKey(path: string): UnitSpriteKey | null {
  const m = path.match(/\/([a-z]+)-p([01])\.png$/);
  if (!m) return null;
  return `${m[1] as UnitType}-${Number(m[2]) as PlayerId}-clean`;
}

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
  const [units, terrain] = await Promise.all([
    loadGlob(UNIT_PNG_URLS, parseUnitKey),
    loadGlob(TERRAIN_PNG_URLS, parseTerrainKey),
  ]);
  return { units, terrain };
}
