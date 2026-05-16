// Continuous terrain-bound effects. Right now this is just factory smoke —
// each owned factory tile emits a small particle every ~250ms that drifts
// upward over 800ms while fading out.
//
// Particles are derived deterministically from `performance.now()` and a
// per-tile hash, so there's no particle pool to manage and the effect is
// reproducible from a screenshot timestamp. The owner's palette tints the
// puff so red and blue factories read as clearly opposed.

import type { GameState, Tile } from '../engine/core/types';
import { PLAYER_COLOURS } from './canvas-palette';
import type { Viewport } from './canvas';

const SMOKE_CADENCE_MS = 250;
const SMOKE_LIFETIME_MS = 800;
const SMOKE_RISE_PX_PER_TILE = 0.65; // fraction of tile height the puff rises
const SMOKE_RADIUS_FRAC = 0.10;       // initial radius as fraction of tile
const SMOKE_RADIUS_GROW = 0.05;       // additional radius over lifetime

function tileHash(x: number, y: number): number {
  let h = (x * 73856093) ^ (y * 19349663);
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 0xffffffff;
}

export function drawFactorySmoke(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  vp: Viewport,
): void {
  const now = performance.now();
  const ts = vp.tileSize;
  const ox = vp.origin.x;
  const oy = vp.origin.y;
  ctx.save();
  for (let y = 0; y < state.map.length; y++) {
    const row = state.map[y]!;
    for (let x = 0; x < row.length; x++) {
      const t: Tile = row[x]!;
      if (t.terrain !== 'factory' || t.owner === null) continue;
      const palette = PLAYER_COLOURS[t.owner];
      const phase = tileHash(x, y) * SMOKE_CADENCE_MS;
      // Render the two currently-alive particles for this tile (one is at
      // most SMOKE_CADENCE_MS old, the previous is up to 2× that age).
      for (let i = 0; i < Math.ceil(SMOKE_LIFETIME_MS / SMOKE_CADENCE_MS); i++) {
        const spawnT = Math.floor((now + phase) / SMOKE_CADENCE_MS - i) * SMOKE_CADENCE_MS - phase;
        const age = now - spawnT;
        if (age < 0 || age > SMOKE_LIFETIME_MS) continue;
        const u = age / SMOKE_LIFETIME_MS;            // 0 → 1 lifetime progress
        const alpha = (1 - u) * 0.55;                 // ease-out fade
        const rise = u * ts * SMOKE_RISE_PX_PER_TILE;
        const radius = ts * (SMOKE_RADIUS_FRAC + u * SMOKE_RADIUS_GROW);
        // Spawn at the chimney corner of the factory sprite (top-right area).
        const cx = ox + x * ts + ts * 0.72;
        const cy = oy + y * ts + ts * 0.30 - rise;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = palette.fill;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}
