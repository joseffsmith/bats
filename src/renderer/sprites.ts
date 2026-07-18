// Unit sprite cache — bakes the hand-authored pixel-art grids into per-team,
// per-variant 16×16 canvases at startup.
//
// The art lives as char-grids under `assets/pixel-art/` (see that dir's
// palette.ts / units / validate.ts). This module is the rasteriser: for every
// (type, owner, variant) it resolves each grid char to RGBA — the team cells
// (A/B/C/D) through the owner's ramp, everything else through the fixed palette
// — and paints a tiny canvas via ImageData. `canvas.ts` `drawImage`s that 16×16
// source scaled to the tile (imageSmoothing already off globally, so it stays
// crisp). Owner 1 is the same grid mirrored horizontally; 'damaged' dims the
// body + steel and stamps a shared soot decal.
//
// No external PNGs anymore — the sprites are generated in-repo, so there's
// nothing to await. `canvas.ts` keeps the identical `get(type, owner, variant)`
// contract, and a `toDataURL` accessor is added for Phase 3B's menu icons.
//
// JSDOM safety: if no 2d context is obtainable (node/jsdom without a canvas
// backend), every entry falls back to the old 1×1 stub host so `drawImage` is a
// visual no-op but the render code paths still run.

import type { PlayerId, UnitType } from '../engine/core/types';
import { PLAYER_COLOURS } from './canvas-palette';
import { UNIT_GRIDS } from './assets/pixel-art/units/index';
import { SOOT_DECAL } from './assets/pixel-art/soot';
import {
  FIXED_PALETTE,
  TEAM_CHARS,
  TRANSPARENT,
  hexToRgba,
  type Rgba,
} from './assets/pixel-art/palette';
import { GRID_SIZE, type PixelGrid } from './assets/pixel-art/types';

export type SpriteVariant = 'clean' | 'damaged';

export type SpriteCache = {
  get(type: UnitType, owner: PlayerId, variant: SpriteVariant): CanvasImageSource;
  /** PNG data URL of the clean sprite (Phase 3B menu icons). Null in stub mode. */
  toDataURL(type: UnitType, owner: PlayerId): string | null;
  size(): number;
  keys(): string[];
};

function cacheKey(type: UnitType, owner: PlayerId, variant: SpriteVariant): string {
  return `${type}-${owner}-${variant}`;
}

const UNIT_TYPES: ReadonlyArray<UnitType> = Object.keys(UNIT_GRIDS) as UnitType[];
const PLAYERS: ReadonlyArray<PlayerId> = [0, 1];
const VARIANTS: ReadonlyArray<SpriteVariant> = ['clean', 'damaged'];

// Chars whose colour dims on the 'damaged' variant: the team ramp (A–D) plus
// the steel stops. Outline, tracks/wood, glass, gold and soot keep their value
// so the beaten-up unit reads as "same shape, darker + scorched", not repainted.
const DIMMED_ON_DAMAGE: ReadonlySet<string> = new Set([...TEAM_CHARS, 'E', 'F', 'G', 'H', 'I']);
const DAMAGE_DIM = 0.35; // multiply RGB by (1 - this)
const SOOT_ALPHA = 0.7; // decal blend strength over an opaque body pixel

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type AnyCtx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** Create a drawable canvas + 2d context, or null when neither is available
 *  (node/jsdom). Prefers HTMLCanvasElement so `toDataURL` is available on the
 *  main thread; falls back to OffscreenCanvas (workers). */
function makeCanvas(w: number, h: number): { canvas: AnyCanvas; ctx: AnyCtx } | null {
  let canvas: AnyCanvas | null = null;
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    canvas = c;
  } else if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(w, h);
  }
  if (!canvas) return null;
  // jsdom without a canvas backend throws from getContext rather than returning
  // null; treat either as "no context" so the cache falls back to stub hosts.
  let ctx: AnyCtx | null = null;
  try {
    ctx = canvas.getContext('2d') as AnyCtx | null;
  } catch {
    return null;
  }
  if (!ctx) return null;
  return { canvas, ctx };
}

function makeStubHost(): CanvasImageSource {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    return c;
  }
  return { width: 1, height: 1 } as unknown as CanvasImageSource;
}

function darken([r, g, b]: Rgba, f: number): Rgba {
  const k = 1 - f;
  return [Math.round(r * k), Math.round(g * k), Math.round(b * k), 255];
}

/** Alpha-composite `over` onto `base` at strength `a` (both opaque RGB). */
function blend(base: Rgba, over: Rgba, a: number): Rgba {
  return [
    Math.round(base[0] * (1 - a) + over[0] * a),
    Math.round(base[1] * (1 - a) + over[1] * a),
    Math.round(base[2] * (1 - a) + over[2] * a),
    255,
  ];
}

/** Resolve a grid char to RGBA (null = transparent). Team cells go through the
 *  owner ramp; everything else through the fixed palette. `damaged` dims the
 *  team + steel stops. */
function resolveColour(ch: string, ramp: readonly Rgba[], damaged: boolean): Rgba | null {
  if (ch === TRANSPARENT) return null;
  const teamIdx = TEAM_CHARS.indexOf(ch as (typeof TEAM_CHARS)[number]);
  let rgba: Rgba;
  if (teamIdx >= 0) {
    rgba = ramp[teamIdx]!;
  } else {
    const hex = FIXED_PALETTE[ch];
    if (!hex) return null; // unknown char — validators reject these, but be safe
    rgba = hexToRgba(hex);
  }
  return damaged && DIMMED_ON_DAMAGE.has(ch) ? darken(rgba, DAMAGE_DIM) : rgba;
}

/** Bake one sprite onto a fresh 16×16 canvas. Returns null if no 2d context. */
function bakeSprite(
  grid: PixelGrid,
  ramp: readonly Rgba[],
  mirror: boolean,
  damaged: boolean,
): AnyCanvas | null {
  const made = makeCanvas(GRID_SIZE, GRID_SIZE);
  if (!made) return null;
  const { canvas, ctx } = made;
  const img = ctx.createImageData(GRID_SIZE, GRID_SIZE);
  const data = img.data;
  for (let y = 0; y < GRID_SIZE; y++) {
    const row = grid[y] ?? '';
    for (let x = 0; x < GRID_SIZE; x++) {
      // Mirror by reading the opposite source column; the destination (x,y) —
      // and thus the soot decal — stays in screen space.
      const sx = mirror ? GRID_SIZE - 1 - x : x;
      let rgba = resolveColour(row[sx] ?? TRANSPARENT, ramp, damaged);
      if (rgba && damaged) {
        const decalCh = SOOT_DECAL[y]?.[x] ?? TRANSPARENT;
        if (decalCh !== TRANSPARENT) {
          const soot = hexToRgba(FIXED_PALETTE[decalCh] ?? '#000000');
          rgba = blend(rgba, soot, SOOT_ALPHA);
        }
      }
      const i = (y * GRID_SIZE + x) * 4;
      if (!rgba) {
        data[i + 3] = 0;
        continue;
      }
      data[i] = rgba[0];
      data[i + 1] = rgba[1];
      data[i + 2] = rgba[2];
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function createSpriteCache(): SpriteCache {
  const map = new Map<string, CanvasImageSource>();
  // Probe once: if we can't get a context, the whole cache is stub hosts.
  const canBake = makeCanvas(GRID_SIZE, GRID_SIZE) !== null;
  const stub = canBake ? null : makeStubHost();

  for (const type of UNIT_TYPES) {
    const grid = UNIT_GRIDS[type];
    for (const owner of PLAYERS) {
      const ramp = PLAYER_COLOURS[owner].ramp.map(hexToRgba);
      const mirror = owner === 1;
      for (const variant of VARIANTS) {
        const baked =
          canBake ? bakeSprite(grid, ramp, mirror, variant === 'damaged') : null;
        map.set(cacheKey(type, owner, variant), baked ?? stub ?? makeStubHost());
      }
    }
  }

  return {
    get(type, owner, variant) {
      const host = map.get(cacheKey(type, owner, variant));
      if (!host) throw new Error(`sprite missing: ${type}-${owner}-${variant}`);
      return host;
    },
    toDataURL(type, owner) {
      const host = map.get(cacheKey(type, owner, 'clean'));
      // OffscreenCanvas has no toDataURL (workers use convertToBlob); return null
      // there. Stub hosts (1×1) also lack it → null, which is the documented
      // "stub mode" signal.
      if (host && typeof (host as HTMLCanvasElement).toDataURL === 'function') {
        return (host as HTMLCanvasElement).toDataURL('image/png');
      }
      return null;
    },
    size() {
      return map.size;
    },
    keys() {
      return Array.from(map.keys());
    },
  };
}
