// Contact sheet for reviewing the baked unit sprites (`?sheet=1`, driven by
// scripts/sprite-sheet.ts). Not part of the game — a flat review page:
//
//   • one labelled row per unit type, each showing p0/p1 × clean/damaged at 3×
//     (48px) and 6× (96px) so both team reads and the damage pass are visible;
//   • a silhouette strip repeating every unit at 24px over a grass-green and a
//     sea-blue field, the "can you still tell them apart small, on terrain?"
//     check.
//
// Deliberately dependency-light: it only pulls the sprite cache. Sets
// `window.__sheetReady` when painting finishes so the screenshot harness can
// wait on a signal rather than a fixed sleep.

import type { PlayerId, TerrainType, UnitType } from '../../../engine/core/types';
import { createSpriteCache, type SpriteVariant } from '../../sprites';
import { createTerrainCache } from '../../terrain';
import { UNIT_GRIDS } from './units/index';
import { TERRAIN_GRIDS } from './terrain/index';

const TYPES = Object.keys(UNIT_GRIDS) as UnitType[];
const TERRAIN_TYPES = Object.keys(TERRAIN_GRIDS) as TerrainType[];
const OWNED_TERRAIN_TYPES: TerrainType[] = ['city', 'hq', 'factory'];

// Palette lifted from index.html :root so the sheet sits in the game's world.
const BG = '#14110d';
const PANEL = '#211c15';
const RULE = '#3a3024';
const INK = '#e8dcc0';
const INK_DIM = '#a39780';
const GOLD = '#d4a857';
const GRASS = '#4a6b3a';
const SEA = '#2a4a6b';

const PAD = 22;
const LABEL_W = 92;
const S6 = 96; // 6× (16 → 96)
const S3 = 48; // 3×
const GROUP_W = S6 + 8 + S3; // one owner/variant cell: 6× beside 3×
const GROUP_GAP = 20;
const ROW_H = S6 + 26;
const HEADER_H = 92;

// 4 combos across a row: p0 clean, p0 damaged, p1 clean, p1 damaged.
const COMBOS: Array<{ owner: PlayerId; variant: SpriteVariant; label: string }> = [
  { owner: 0, variant: 'clean', label: 'p0 clean' },
  { owner: 0, variant: 'damaged', label: 'p0 damaged' },
  { owner: 1, variant: 'clean', label: 'p1 clean' },
  { owner: 1, variant: 'damaged', label: 'p1 damaged' },
];

const GRID_W = PAD + LABEL_W + COMBOS.length * GROUP_W + (COMBOS.length - 1) * GROUP_GAP + PAD;
const STRIP_H = 24 * 2 + 90; // two bg bands + labels

// ── Terrain section (Phase 3B) ──
const T3 = 48; // terrain tile at 3×
const T_GAP = 12;
const T_ROW_H = T3 + 30; // tile + label
const SEAM_TILE = 24; // 4×4 seam-check tile size
const SEAM_BLOCK = SEAM_TILE * 4;
const TERRAIN_H =
  34 + // section title
  T_ROW_H + // all 8 terrains
  26 + T_ROW_H + // owned-buildings sub-title + row
  30 + SEAM_BLOCK + 20; // seam-check title + block + labels

const CANVAS_W = Math.max(GRID_W, 820);
const CANVAS_H = HEADER_H + TYPES.length * ROW_H + STRIP_H + PAD + TERRAIN_H + PAD * 2;

export function runSheet(parent: HTMLElement): void {
  parent.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  canvas.style.cssText = `display:block;width:${CANVAS_W}px;height:${CANVAS_H}px;`;
  parent.appendChild(canvas);
  // The game's global CSS pins html/body/#app to the viewport with
  // overflow:hidden. Override that here so the (tall) canvas extends the
  // document and a full-page screenshot captures every row.
  parent.style.cssText = 'display:block;width:auto;height:auto;overflow:visible;';
  document.documentElement.style.cssText = 'height:auto;overflow:visible;';
  document.body.style.cssText = `height:${CANVAS_H}px;overflow:visible;background:${BG};`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false; // keep the pixel art crisp on upscale

  const sprites = createSpriteCache();

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // ── Title + column headers ──
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = GOLD;
  ctx.font = '600 20px ui-monospace, monospace';
  ctx.fillText('Unit sprites — Phase 3A contact sheet', PAD, PAD + 16);
  ctx.fillStyle = INK_DIM;
  ctx.font = '12px ui-monospace, monospace';
  ctx.fillText('16×16 hand-authored grids, baked per team ramp · 3× and 6×', PAD, PAD + 36);

  const colY = HEADER_H - 8;
  ctx.font = '12px ui-monospace, monospace';
  ctx.textAlign = 'center';
  COMBOS.forEach((combo, ci) => {
    const gx = PAD + LABEL_W + ci * (GROUP_W + GROUP_GAP);
    ctx.fillStyle = combo.owner === 0 ? '#e07a6a' : '#7aa6e0';
    ctx.fillText(combo.label, gx + GROUP_W / 2, colY);
  });
  ctx.textAlign = 'left';

  // ── One row per unit type ──
  TYPES.forEach((type, ti) => {
    const rowY = HEADER_H + ti * ROW_H;
    // Alternating panel band for legibility.
    if (ti % 2 === 0) {
      ctx.fillStyle = PANEL;
      ctx.fillRect(0, rowY, CANVAS_W, ROW_H);
    }
    ctx.fillStyle = INK;
    ctx.font = '12px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(type, PAD, rowY + ROW_H / 2);

    COMBOS.forEach((combo, ci) => {
      const gx = PAD + LABEL_W + ci * (GROUP_W + GROUP_GAP);
      const big = sprites.get(type, combo.owner, combo.variant);
      const small = big; // same source, drawn at two scales
      const cy = rowY + (ROW_H - S6) / 2;
      ctx.drawImage(big, gx, cy, S6, S6);
      ctx.drawImage(small, gx + S6 + 8, cy + (S6 - S3) / 2, S3, S3);
    });
  });

  // ── Silhouette strip: every unit small, on grass + sea ──
  const stripY = HEADER_H + TYPES.length * ROW_H + PAD;
  ctx.fillStyle = GOLD;
  ctx.font = '12px ui-monospace, monospace';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Silhouette check — 24px on terrain (p0 then p1, per type)', PAD, stripY + 4);

  const s24 = 24;
  const cellW = s24 + 4;
  const bands: Array<{ bg: string; name: string }> = [
    { bg: GRASS, name: 'grass' },
    { bg: SEA, name: 'sea' },
  ];
  bands.forEach((band, bi) => {
    const by = stripY + 16 + bi * (s24 + 8);
    const bandW = TYPES.length * 2 * cellW + 8;
    ctx.fillStyle = band.bg;
    ctx.fillRect(PAD, by, Math.min(bandW, CANVAS_W - PAD * 2), s24 + 4);
    let x = PAD + 4;
    for (const type of TYPES) {
      for (const owner of [0, 1] as PlayerId[]) {
        ctx.drawImage(sprites.get(type, owner, 'clean'), x, by + 2, s24, s24);
        x += cellW;
      }
    }
  });

  // Thin rules under the header + around the strip for structure.
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H - 0.5);
  ctx.lineTo(CANVAS_W, HEADER_H - 0.5);
  ctx.stroke();

  // ── Terrain section (Phase 3B) ──
  const terrainTop = stripY + STRIP_H + PAD;
  drawTerrainSection(ctx, terrainTop);

  (window as unknown as { __sheetReady?: boolean }).__sheetReady = true;
}

/** Baked terrain tiles: all 8 at 3×, the 3 capturables × {neutral,p0,p1}, and a
 *  4×4 tiling seam check for plain + sea. */
function drawTerrainSection(ctx: CanvasRenderingContext2D, top: number): void {
  const terrain = createTerrainCache();
  let y = top;

  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y - 0.5);
  ctx.lineTo(CANVAS_W, y - 0.5);
  ctx.stroke();
  y += 22;

  ctx.fillStyle = GOLD;
  ctx.font = '600 16px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Terrain — hand-authored 16×16 tiles, baked full-bleed', PAD, y);
  y += 20;

  // Row 1: all 8 terrains at 3×.
  let x = PAD;
  for (const t of TERRAIN_TYPES) {
    const img = terrain.get(t, null);
    if (img) ctx.drawImage(img, x, y, T3, T3);
    ctx.fillStyle = INK_DIM;
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(t, x + T3 / 2, y + T3 + 14);
    x += T3 + T_GAP;
  }
  y += T_ROW_H;

  // Row 2: owned buildings × {neutral, p0, p1}.
  ctx.fillStyle = INK_DIM;
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('Ownership variants — neutral / p0 / p1 (team ramp on roof/banner/pad)', PAD, y);
  y += 18;
  x = PAD;
  const owners: Array<{ owner: PlayerId | null; tag: string; ink: string }> = [
    { owner: null, tag: 'neutral', ink: INK_DIM },
    { owner: 0, tag: 'p0', ink: '#e07a6a' },
    { owner: 1, tag: 'p1', ink: '#7aa6e0' },
  ];
  for (const t of OWNED_TERRAIN_TYPES) {
    for (const o of owners) {
      const img = terrain.get(t, o.owner);
      if (img) ctx.drawImage(img, x, y, T3, T3);
      ctx.fillStyle = o.ink;
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${t} ${o.tag}`, x + T3 / 2, y + T3 + 13);
      x += T3 + 6;
    }
    x += T_GAP; // gap between types
  }
  y += T_ROW_H;

  // Row 3: 4×4 seam check for plain + sea — no visible grid should appear.
  ctx.fillStyle = GOLD;
  ctx.font = '12px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('Tiling seam check — 4×4 repeat (look for a grid)', PAD, y);
  y += 16;
  const seams: Array<{ t: TerrainType; label: string }> = [
    { t: 'plain', label: 'plain' },
    { t: 'sea', label: 'sea' },
  ];
  x = PAD;
  for (const s of seams) {
    const img = terrain.get(s.t, null);
    if (img) {
      for (let ty = 0; ty < 4; ty++) {
        for (let tx = 0; tx < 4; tx++) {
          ctx.drawImage(img, x + tx * SEAM_TILE, y + ty * SEAM_TILE, SEAM_TILE, SEAM_TILE);
        }
      }
    }
    ctx.fillStyle = INK_DIM;
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(s.label, x + SEAM_BLOCK / 2, y + SEAM_BLOCK + 14);
    x += SEAM_BLOCK + T_GAP * 2;
  }
}
