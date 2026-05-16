// Terrain rendering — modern tactical icon set.
//
// Each terrain type has a dedicated painter:
//   plain    soft olive with subtle dappling
//   road     connected lanes with dashed centerline
//   forest   simplified pine clusters
//   mountain bare rock with geometric facet shading
//   sea      gradient water with cyan glints
//   city     modern high-rises with lit window grids
//   hq       command bunker + antenna mast with LED beacon
//   factory  industrial plant: building + cooling tower with steam
//
// Ownership for capturable tiles (city/HQ/factory) is communicated with a
// player-coloured LED dot at the top-right of the tile plus a thin top-edge
// stripe — a modern HUD cue rather than a medieval flag.
//
// Deterministic per-tile variation comes from a coord hash so the map looks
// organic without flickering across redraws.

import type { GameState, PlayerId, TerrainType } from '../engine/core/types';
import type { Viewport } from './canvas';

// ─────────────────────────── Palette ─────────────────────────────────────────

const PLAIN: readonly string[] = ['#c5d28a', '#cad88f', '#bccc81'];

const ROAD = {
  base: '#5a5e66',       // warm asphalt
  edge: '#3a3d44',
  lane: '#e8dcc0',       // cream lane stripe
};

const FOREST = {
  ground: '#8aa766',
  trunk: '#2a1c10',
  pineDark: '#2c4a26',
  pineMid: '#3e6b34',
  pineLight: '#578c45',
};

const MOUNTAIN = {
  ground: '#9b8e6f',     // warm earth pad
  rockMid: '#6e5538',
  rockShadow: '#3d2a18',
  rockHighlight: '#a07e52',
};

const SEA = {
  deep: '#1d4970',
  mid: '#27628e',
  crest: '#6da4cf',
  glint: 'rgba(165, 220, 240, 0.55)',
};

const CITY = {
  ground: '#9ea2a8',      // concrete plaza
  groundHi: '#b1b5bc',
  buildingA: '#e3d7b6',   // pale steel/cream
  buildingB: '#c8bd9e',
  buildingShade: '#7c7158',
  windowOn: '#f6d472',    // warm lit window
  windowOff: '#3a3326',
  roofCap: '#3c3a32',
};

const HQ_PAD: Record<NonNullable<PlayerId> | 'neutral', { pad: string; padHi: string; wall: string; trim: string }> = {
  0: { pad: '#7a4d2c', padHi: '#a06d3f', wall: '#e8dcc0', trim: '#3a2618' },
  1: { pad: '#2a4d70', padHi: '#3d6e9a', wall: '#e8dcc0', trim: '#162a3e' },
  neutral: { pad: '#5a5e66', padHi: '#7a7e88', wall: '#c4c7cd', trim: '#2a2e36' },
};

const FACTORY = {
  ground: '#6a6e78',
  wall: '#9ea2ac',
  wallHi: '#b8bcc4',
  roof: '#3a3e48',
  vent: '#22262e',
  tower: '#8a8e98',
  towerCap: '#3a3e48',
  tank: '#b8bcc4',
  steam: 'rgba(220, 220, 220, 0.55)',
};

const PLAYER_LED: Record<PlayerId, { core: string; glow: string }> = {
  0: { core: '#ff5a5a', glow: 'rgba(255, 90, 90, 0.55)' },
  1: { core: '#5aaee4', glow: 'rgba(90, 174, 228, 0.55)' },
};

const GRID = 'rgba(0,0,0,0.10)';

// ─────────────────────────── Public entry point ──────────────────────────────

export function drawTerrain(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  vp: Viewport,
): void {
  const map = state.map;
  for (let y = 0; y < map.length; y++) {
    const row = map[y]!;
    for (let x = 0; x < row.length; x++) {
      const tile = row[x]!;
      const px = vp.origin.x + x * vp.tileSize;
      const py = vp.origin.y + y * vp.tileSize;
      const ts = vp.tileSize;
      const seed = hash2(x, y);

      switch (tile.terrain) {
        case 'plain':
          drawPlain(ctx, px, py, ts, seed);
          break;
        case 'road':
          drawRoad(ctx, px, py, ts, x, y, map);
          break;
        case 'forest':
          drawForest(ctx, px, py, ts, seed);
          break;
        case 'mountain':
          drawMountain(ctx, px, py, ts, seed);
          break;
        case 'sea':
          drawSea(ctx, px, py, ts, seed);
          break;
        case 'city':
          drawCity(ctx, px, py, ts, tile.owner);
          break;
        case 'hq':
          drawHQ(ctx, px, py, ts, tile.owner);
          break;
        case 'factory':
          drawFactory(ctx, px, py, ts, tile.owner);
          break;
      }

      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, ts - 1, ts - 1);
    }
  }
}

// ─────────────────────────── Plain ───────────────────────────────────────────

function drawPlain(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  ts: number,
  seed: number,
): void {
  const variantIdx = Math.floor(seed * 3) % 3;
  ctx.fillStyle = PLAIN[variantIdx]!;
  ctx.fillRect(px, py, ts, ts);

  // Two faint grass tufts at hash-positioned offsets.
  ctx.strokeStyle = 'rgba(40, 60, 20, 0.32)';
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  const tufts: Array<[number, number]> = [
    [px + ts * (0.22 + hashAt(seed, 1) * 0.18), py + ts * (0.32 + hashAt(seed, 2) * 0.16)],
    [px + ts * (0.62 + hashAt(seed, 3) * 0.18), py + ts * (0.62 + hashAt(seed, 4) * 0.16)],
  ];
  for (const [tx, ty] of tufts) {
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx + 1, ty - ts * 0.06);
    ctx.moveTo(tx + ts * 0.04, ty);
    ctx.lineTo(tx + ts * 0.04 + 1, ty - ts * 0.05);
    ctx.stroke();
  }
}

// ─────────────────────────── Road ────────────────────────────────────────────

function drawRoad(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  ts: number,
  x: number,
  y: number,
  map: GameState['map'],
): void {
  const isPath = (xx: number, yy: number): boolean => {
    const row = map[yy];
    if (!row) return false;
    const t = row[xx];
    if (!t) return false;
    return (
      t.terrain === 'road' ||
      t.terrain === 'hq' ||
      t.terrain === 'factory' ||
      t.terrain === 'city'
    );
  };

  const cx = px + ts / 2;
  const cy = py + ts / 2;
  const w = Math.max(8, ts * 0.42);   // lane width

  // Road asphalt is the underlying ground (so non-connecting roads still read)
  ctx.fillStyle = ROAD.base;
  // Always paint a centre disc so isolated/dead-end roads still feel like roads.
  ctx.beginPath();
  ctx.arc(cx, cy, w * 0.5, 0, Math.PI * 2);
  ctx.fill();

  // Paint asphalt strips toward each connecting neighbour.
  if (isPath(x, y - 1)) ctx.fillRect(cx - w / 2, py, w, ts / 2 + 1);
  if (isPath(x, y + 1)) ctx.fillRect(cx - w / 2, cy, w, ts / 2 + 1);
  if (isPath(x - 1, y)) ctx.fillRect(px, cy - w / 2, ts / 2 + 1, w);
  if (isPath(x + 1, y)) ctx.fillRect(cx, cy - w / 2, ts / 2 + 1, w);

  // Curb edges — slightly darker, drawn just inside the asphalt outline.
  ctx.strokeStyle = ROAD.edge;
  ctx.lineWidth = 1;
  const curb = (x0: number, y0: number, w0: number, h0: number): void => {
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w0 - 1, h0 - 1);
  };
  if (isPath(x, y - 1)) curb(cx - w / 2, py, w, ts / 2 + 1);
  if (isPath(x, y + 1)) curb(cx - w / 2, cy, w, ts / 2 + 1);
  if (isPath(x - 1, y)) curb(px, cy - w / 2, ts / 2 + 1, w);
  if (isPath(x + 1, y)) curb(cx, cy - w / 2, ts / 2 + 1, w);

  // Dashed lane stripes down the centre of each connecting arm.
  ctx.strokeStyle = ROAD.lane;
  ctx.lineWidth = Math.max(1, ts * 0.04);
  ctx.lineCap = 'butt';
  ctx.setLineDash([ts * 0.10, ts * 0.08]);
  if (isPath(x, y - 1)) {
    ctx.beginPath();
    ctx.moveTo(cx, py);
    ctx.lineTo(cx, cy - w * 0.35);
    ctx.stroke();
  }
  if (isPath(x, y + 1)) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + w * 0.35);
    ctx.lineTo(cx, py + ts);
    ctx.stroke();
  }
  if (isPath(x - 1, y)) {
    ctx.beginPath();
    ctx.moveTo(px, cy);
    ctx.lineTo(cx - w * 0.35, cy);
    ctx.stroke();
  }
  if (isPath(x + 1, y)) {
    ctx.beginPath();
    ctx.moveTo(cx + w * 0.35, cy);
    ctx.lineTo(px + ts, cy);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

// ─────────────────────────── Forest ──────────────────────────────────────────

function drawForest(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  ts: number,
  seed: number,
): void {
  ctx.fillStyle = FOREST.ground;
  ctx.fillRect(px, py, ts, ts);

  const trees: Array<{ x: number; y: number; size: number; shade: 'dark' | 'mid' | 'light' }> = [
    { x: 0.26, y: 0.32, size: 0.46, shade: 'mid' },
    { x: 0.66, y: 0.40, size: 0.52, shade: 'dark' },
    { x: 0.44, y: 0.70, size: 0.44, shade: 'light' },
  ];
  trees.sort((a, b) => a.y - b.y);

  for (let i = 0; i < trees.length; i++) {
    const t = trees[i]!;
    const jitterX = (hashAt(seed, i + 1) - 0.5) * 0.05;
    const jitterY = (hashAt(seed, i + 5) - 0.5) * 0.05;
    const tx = px + ts * (t.x + jitterX);
    const ty = py + ts * (t.y + jitterY);
    const sz = ts * t.size;
    drawPine(ctx, tx, ty, sz, t.shade);
  }
}

function drawPine(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  sz: number,
  shade: 'dark' | 'mid' | 'light',
): void {
  const w = sz * 0.5;
  const h = sz * 0.7;
  // Trunk.
  ctx.fillStyle = FOREST.trunk;
  ctx.fillRect(cx - sz * 0.05, cy + h * 0.32, sz * 0.10, sz * 0.18);

  const fill =
    shade === 'dark' ? FOREST.pineDark : shade === 'mid' ? FOREST.pineMid : FOREST.pineLight;
  ctx.fillStyle = fill;
  // Simpler, more geometric: a single tall triangle rather than two stacked.
  ctx.beginPath();
  ctx.moveTo(cx, cy - h * 0.55);
  ctx.lineTo(cx + w * 0.65, cy + h * 0.34);
  ctx.lineTo(cx - w * 0.65, cy + h * 0.34);
  ctx.closePath();
  ctx.fill();

  // East-side shadow facet.
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.moveTo(cx, cy - h * 0.55);
  ctx.lineTo(cx + w * 0.65, cy + h * 0.34);
  ctx.lineTo(cx, cy + h * 0.34);
  ctx.closePath();
  ctx.fill();
}

// ─────────────────────────── Mountain ────────────────────────────────────────

function drawMountain(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  ts: number,
  seed: number,
): void {
  ctx.fillStyle = MOUNTAIN.ground;
  ctx.fillRect(px, py, ts, ts);

  // Faceted peak — three flat planes meeting at the summit, no snow cap.
  const summitX = px + ts * (0.42 + hashAt(seed, 1) * 0.16);
  const summitY = py + ts * (0.16 + hashAt(seed, 2) * 0.06);
  const baseL = px + ts * 0.10;
  const baseR = px + ts * 0.90;
  const baseY = py + ts * 0.84;
  const midX = px + ts * (0.30 + hashAt(seed, 3) * 0.10);
  const midY = py + ts * 0.58;

  // West (lit) face.
  ctx.fillStyle = MOUNTAIN.rockHighlight;
  ctx.beginPath();
  ctx.moveTo(summitX, summitY);
  ctx.lineTo(midX, midY);
  ctx.lineTo(baseL, baseY);
  ctx.closePath();
  ctx.fill();

  // Lower west foot (mid tone).
  ctx.fillStyle = MOUNTAIN.rockMid;
  ctx.beginPath();
  ctx.moveTo(midX, midY);
  ctx.lineTo(summitX, summitY);
  ctx.lineTo(summitX, baseY);
  ctx.lineTo(baseL, baseY);
  ctx.closePath();
  ctx.fill();

  // East (shadow) face.
  ctx.fillStyle = MOUNTAIN.rockShadow;
  ctx.beginPath();
  ctx.moveTo(summitX, summitY);
  ctx.lineTo(baseR, baseY);
  ctx.lineTo(summitX, baseY);
  ctx.closePath();
  ctx.fill();

  // Faint summit highlight rim.
  ctx.strokeStyle = 'rgba(232, 220, 192, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(summitX, summitY);
  ctx.lineTo(midX, midY);
  ctx.lineTo(baseL, baseY);
  ctx.stroke();
}

// ─────────────────────────── Sea ─────────────────────────────────────────────

function drawSea(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  ts: number,
  seed: number,
): void {
  const grad = ctx.createLinearGradient(px, py, px, py + ts);
  grad.addColorStop(0, SEA.mid);
  grad.addColorStop(1, SEA.deep);
  ctx.fillStyle = grad;
  ctx.fillRect(px, py, ts, ts);

  ctx.strokeStyle = SEA.crest;
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  const wave = (cy: number): void => {
    ctx.beginPath();
    ctx.moveTo(px + ts * 0.12, cy);
    ctx.quadraticCurveTo(px + ts * 0.30, cy - ts * 0.04, px + ts * 0.5, cy);
    ctx.quadraticCurveTo(px + ts * 0.70, cy + ts * 0.04, px + ts * 0.88, cy);
    ctx.stroke();
  };
  wave(py + ts * (0.30 + hashAt(seed, 1) * 0.10));
  wave(py + ts * (0.62 + hashAt(seed, 2) * 0.10));

  // Cyan glint on one of the wave crests.
  ctx.fillStyle = SEA.glint;
  if (hashAt(seed, 7) > 0.55) {
    ctx.fillRect(
      px + ts * (0.30 + hashAt(seed, 8) * 0.40),
      py + ts * (0.30 + hashAt(seed, 9) * 0.30),
      ts * 0.10,
      1,
    );
  }
}

// ─────────────────────────── City (modern high-rises) ────────────────────────

function drawCity(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  ts: number,
  owner: PlayerId | null,
): void {
  // Concrete plaza with subtle horizon-band gradient.
  const grad = ctx.createLinearGradient(px, py, px, py + ts);
  grad.addColorStop(0, CITY.groundHi);
  grad.addColorStop(1, CITY.ground);
  ctx.fillStyle = grad;
  ctx.fillRect(px, py, ts, ts);

  type Tower = { x: number; w: number; h: number; tone: 'A' | 'B'; cols: number; rows: number };
  const towers: Tower[] = [
    { x: 0.10, w: 0.22, h: 0.50, tone: 'A', cols: 2, rows: 4 },
    { x: 0.36, w: 0.26, h: 0.66, tone: 'B', cols: 3, rows: 5 },
    { x: 0.66, w: 0.22, h: 0.42, tone: 'A', cols: 2, rows: 3 },
  ];

  for (const t of towers) {
    const bx = px + ts * t.x;
    const by = py + ts * (0.88 - t.h);
    const bw = ts * t.w;
    const bh = ts * t.h;

    // Facade.
    ctx.fillStyle = t.tone === 'A' ? CITY.buildingA : CITY.buildingB;
    ctx.fillRect(bx, by, bw, bh);
    // East-side shadow strip.
    ctx.fillStyle = CITY.buildingShade;
    ctx.fillRect(bx + bw - ts * 0.04, by, ts * 0.04, bh);

    // Window grid — small dots arranged in even rows. Most are lit (warm),
    // a few are dark to feel real.
    const padX = ts * 0.02;
    const padY = ts * 0.03;
    const winW = (bw - padX * 2) / t.cols - ts * 0.015;
    const winH = (bh - padY * 2) / t.rows - ts * 0.022;
    const seed = hash2(Math.floor(bx), Math.floor(by));
    let n = 0;
    for (let r = 0; r < t.rows; r++) {
      for (let c = 0; c < t.cols; c++) {
        const wx = bx + padX + c * ((bw - padX * 2) / t.cols);
        const wy = by + padY + r * ((bh - padY * 2) / t.rows);
        const lit = hashAt(seed, n++) > 0.32;
        ctx.fillStyle = lit ? CITY.windowOn : CITY.windowOff;
        ctx.fillRect(wx, wy, Math.max(1, winW), Math.max(1, winH));
      }
    }

    // Roof cap — thin dark band on top.
    ctx.fillStyle = CITY.roofCap;
    ctx.fillRect(bx, by - ts * 0.02, bw, ts * 0.025);
  }

  if (owner !== null) drawOwnerCue(ctx, px, py, ts, owner);
}

// ─────────────────────────── HQ (command bunker + antenna) ───────────────────

function drawHQ(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  ts: number,
  owner: PlayerId | null,
): void {
  const pal = owner === null ? HQ_PAD.neutral : HQ_PAD[owner];

  // Pad with subtle diagonal gradient — player-tinted concrete.
  const grad = ctx.createLinearGradient(px, py, px + ts, py + ts);
  grad.addColorStop(0, pal.padHi);
  grad.addColorStop(1, pal.pad);
  ctx.fillStyle = grad;
  ctx.fillRect(px, py, ts, ts);

  // Sandbag ring at the corners — small rounded blocks suggesting perimeter.
  ctx.fillStyle = pal.trim;
  const sb = ts * 0.06;
  ctx.fillRect(px + ts * 0.04, py + ts * 0.04, sb, sb);
  ctx.fillRect(px + ts - sb - ts * 0.04, py + ts * 0.04, sb, sb);
  ctx.fillRect(px + ts * 0.04, py + ts - sb - ts * 0.04, sb, sb);
  ctx.fillRect(px + ts - sb - ts * 0.04, py + ts - sb - ts * 0.04, sb, sb);

  // Bunker — low, wide, flat-roof building.
  const bx = px + ts * 0.22;
  const by = py + ts * 0.46;
  const bw = ts * 0.56;
  const bh = ts * 0.32;
  ctx.fillStyle = pal.wall;
  ctx.fillRect(bx, by, bw, bh);
  // East shadow strip.
  ctx.fillStyle = pal.trim;
  ctx.fillRect(bx + bw - ts * 0.06, by, ts * 0.06, bh);
  // Roof cap.
  ctx.fillStyle = pal.trim;
  ctx.fillRect(bx - ts * 0.02, by - ts * 0.04, bw + ts * 0.04, ts * 0.06);

  // Slit window strip across the front.
  ctx.fillStyle = pal.trim;
  ctx.fillRect(bx + ts * 0.06, by + ts * 0.10, bw - ts * 0.12, ts * 0.04);

  // Bay door.
  ctx.fillStyle = pal.trim;
  const doorW = ts * 0.12;
  ctx.fillRect(bx + (bw - doorW) / 2, by + bh - ts * 0.14, doorW, ts * 0.14);

  // Antenna mast rising above the bunker, with horizontal cross-bar.
  const mastX = bx + bw * 0.7;
  const mastTopY = py + ts * 0.10;
  ctx.strokeStyle = pal.trim;
  ctx.lineWidth = Math.max(1, ts * 0.025);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(mastX, by - ts * 0.04);
  ctx.lineTo(mastX, mastTopY);
  ctx.stroke();
  // Cross-bar (small dish/array).
  ctx.beginPath();
  ctx.moveTo(mastX - ts * 0.08, mastTopY + ts * 0.06);
  ctx.lineTo(mastX + ts * 0.08, mastTopY + ts * 0.06);
  ctx.stroke();
  // Smaller upper bar.
  ctx.lineWidth = Math.max(1, ts * 0.015);
  ctx.beginPath();
  ctx.moveTo(mastX - ts * 0.04, mastTopY + ts * 0.02);
  ctx.lineTo(mastX + ts * 0.04, mastTopY + ts * 0.02);
  ctx.stroke();

  // Beacon LED at the very top — player-coloured pulse.
  if (owner !== null) {
    const led = PLAYER_LED[owner];
    ctx.fillStyle = led.glow;
    ctx.beginPath();
    ctx.arc(mastX, mastTopY - ts * 0.02, ts * 0.06, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = led.core;
    ctx.beginPath();
    ctx.arc(mastX, mastTopY - ts * 0.02, ts * 0.035, 0, Math.PI * 2);
    ctx.fill();
  }

  if (owner !== null) drawOwnerCue(ctx, px, py, ts, owner);
}

// ─────────────────────────── Factory (modern industrial plant) ───────────────

function drawFactory(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  ts: number,
  owner: PlayerId | null,
): void {
  // Concrete pad.
  ctx.fillStyle = FACTORY.ground;
  ctx.fillRect(px, py, ts, ts);

  // Main hangar — long flat-roof building.
  const bx = px + ts * 0.10;
  const by = py + ts * 0.46;
  const bw = ts * 0.54;
  const bh = ts * 0.36;
  ctx.fillStyle = FACTORY.wall;
  ctx.fillRect(bx, by, bw, bh);
  // West-side highlight strip.
  ctx.fillStyle = FACTORY.wallHi;
  ctx.fillRect(bx, by, ts * 0.04, bh);
  // Roof.
  ctx.fillStyle = FACTORY.roof;
  ctx.fillRect(bx - ts * 0.02, by - ts * 0.04, bw + ts * 0.04, ts * 0.06);

  // Roof vents — three small dark slits across the roof.
  ctx.fillStyle = FACTORY.vent;
  for (let i = 0; i < 3; i++) {
    const vx = bx + ts * 0.06 + i * ts * 0.16;
    ctx.fillRect(vx, by - ts * 0.06, ts * 0.08, ts * 0.02);
  }

  // Bay door — large, slatted.
  ctx.fillStyle = FACTORY.vent;
  const doorW = ts * 0.20;
  const doorH = ts * 0.22;
  const doorX = bx + ts * 0.06;
  const doorY = by + bh - doorH;
  ctx.fillRect(doorX, doorY, doorW, doorH);
  ctx.strokeStyle = 'rgba(220, 220, 220, 0.20)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    const yy = doorY + (doorH / 5) * i;
    ctx.beginPath();
    ctx.moveTo(doorX, yy);
    ctx.lineTo(doorX + doorW, yy);
    ctx.stroke();
  }
  // Personnel window.
  ctx.fillStyle = CITY.windowOn;
  ctx.fillRect(bx + bw - ts * 0.14, by + ts * 0.08, ts * 0.04, ts * 0.06);

  // Cooling tower — tall cylinder on the east side.
  const towerX = px + ts * 0.72;
  const towerY = py + ts * 0.30;
  const towerW = ts * 0.16;
  const towerH = ts * 0.50;
  ctx.fillStyle = FACTORY.tower;
  ctx.fillRect(towerX, towerY, towerW, towerH);
  // Tower body shading (right side).
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.fillRect(towerX + towerW - ts * 0.04, towerY, ts * 0.04, towerH);
  // Tower top cap.
  ctx.fillStyle = FACTORY.towerCap;
  ctx.fillRect(towerX - ts * 0.02, towerY - ts * 0.02, towerW + ts * 0.04, ts * 0.04);

  // Steam plume rising from the tower.
  ctx.fillStyle = FACTORY.steam;
  ctx.beginPath();
  ctx.arc(towerX + towerW * 0.5, towerY - ts * 0.06, ts * 0.07, 0, Math.PI * 2);
  ctx.arc(towerX + towerW * 0.3, towerY - ts * 0.14, ts * 0.06, 0, Math.PI * 2);
  ctx.arc(towerX + towerW * 0.7, towerY - ts * 0.16, ts * 0.05, 0, Math.PI * 2);
  ctx.fill();

  // Small storage tank between hangar and tower.
  ctx.fillStyle = FACTORY.tank;
  ctx.beginPath();
  ctx.arc(px + ts * 0.66, py + ts * 0.70, ts * 0.08, 0, Math.PI * 2);
  ctx.fill();
  // Tank shadow crescent.
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.arc(px + ts * 0.69, py + ts * 0.71, ts * 0.07, -Math.PI * 0.3, Math.PI * 0.7);
  ctx.fill();

  if (owner !== null) drawOwnerCue(ctx, px, py, ts, owner);
}

// ─────────────────────────── Owner cue (HUD LED) ─────────────────────────────

function drawOwnerCue(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  ts: number,
  owner: PlayerId,
): void {
  const led = PLAYER_LED[owner];
  // Thin LED stripe along the top edge of the tile.
  ctx.fillStyle = led.glow;
  ctx.fillRect(px + ts * 0.10, py + 1, ts * 0.80, 1);
  ctx.fillStyle = led.core;
  ctx.fillRect(px + ts * 0.34, py + 1, ts * 0.32, 1);

  // LED dot at the top-right corner — glow halo + core.
  const dx = px + ts - ts * 0.14;
  const dy = py + ts * 0.10;
  ctx.fillStyle = led.glow;
  ctx.beginPath();
  ctx.arc(dx, dy, ts * 0.07, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = led.core;
  ctx.beginPath();
  ctx.arc(dx, dy, ts * 0.038, 0, Math.PI * 2);
  ctx.fill();
}

// ─────────────────────────── Hash helpers ────────────────────────────────────

/** Deterministic [0,1) hash from (x,y). */
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Stretch a seed into multiple sub-values for varied placements. */
function hashAt(seed: number, salt: number): number {
  const v = Math.sin(seed * 1000 + salt * 13.37) * 43758.5453;
  return v - Math.floor(v);
}

export type { TerrainType };
