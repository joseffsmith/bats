// Tile-grid canvas renderer.
//
// Pure-draw module: takes a GameState plus presentation state (selection,
// overlays, animation hints) and paints pixels. Owns no game state of its own
// beyond a `dirty` flag and the cached DPR-aware canvas dimensions.
//
// Layout: the map grid is centred in the viewport. The HUD bar sits at the top
// of the canvas (drawn separately by hud.ts via the same context). Unit
// rendering uses filled coloured squares plus a contrasting type letter.

import type {
  Coord,
  GameState,
  PlayerId,
  TerrainType,
  Unit,
  UnitType,
} from '../engine/core/types';
import { tileAt, unitAt } from '../engine/core/types';
import type { AnimationQueue, Anim } from './animations';

// ─────────────────────────── Constants ───────────────────────────────────────

export const TILE_SIZE_DESKTOP = 48;
export const TILE_SIZE_MOBILE = 32;
export const MOBILE_BREAKPOINT = 768;
export const HUD_HEIGHT = 56;

export type PlayerPalette = { fill: string; letter: string };

export const PLAYER_COLOURS: Record<PlayerId, PlayerPalette> = {
  0: { fill: '#c83030', letter: '#fff5d0' }, // crimson red w/ pale yellow letter
  1: { fill: '#2860c0', letter: '#e6ecff' }, // royal blue w/ pale blue letter
};

const NEUTRAL_HQ_OWNER_FILL = '#555';

/** Background colour per terrain type. Tuned to be distinct from player colours. */
const TERRAIN_FILL: Record<TerrainType, string> = {
  plain: '#c9d59a', // pale olive
  road: '#bcb6a4', // light grey-tan
  forest: '#3e6a3a', // dark green
  mountain: '#7a5a3a', // brown
  sea: '#1f4d8a', // deep blue
  city: '#e8d680', // pale yellow
  hq: '#bfa030', // gold (overridden per owner below)
  factory: '#6e7480', // steel grey
};

const TERRAIN_LETTER: Record<TerrainType, string> = {
  plain: '',
  road: '',
  forest: 'F',
  mountain: 'M',
  sea: '',
  city: 'C',
  hq: 'H',
  factory: 'X',
};

const TERRAIN_LETTER_COLOUR: Record<TerrainType, string> = {
  plain: '',
  road: '',
  forest: '#2a4a28', // darker green
  mountain: '#3a2a12', // darker brown
  sea: '',
  city: '#7a6620',
  hq: '#1a1a1a',
  factory: '#3a3e44',
};

const OWNER_INDICATOR: Record<PlayerId, string> = {
  0: '#ff7070',
  1: '#70a0ff',
};

const UNIT_LETTER: Record<UnitType, string> = {
  infantry: 'I',
  recon: 'R',
  tank: 'T',
  artillery: 'A',
  copter: 'C',
};

// ─────────────────────────── View state ──────────────────────────────────────

export type Overlay = {
  /** Tiles to highlight in the movement-range blue. */
  moveRange?: Coord[];
  /** Tiles to highlight in the attack-range red. */
  attackRange?: Coord[];
  /** Tiles to highlight as capturable hint. */
  capturable?: Coord[];
  /** Tiles drawn as the currently-previewed move path. */
  movePath?: Coord[];
  /** Single selected unit, drawn with a yellow border. */
  selected?: Coord;
  /** Hover tile, used for the damage tooltip. */
  hover?: Coord | null;
  /** Floating damage preview. */
  damagePreview?: { tile: Coord; dealt: number; received: number } | null;
  /** Action menu anchor tile + entries. */
  actionMenu?: { tile: Coord; entries: ActionMenuEntry[] } | null;
  /** Build menu (factory click): list of buildable units + affordability. */
  buildMenu?: { tile: Coord; entries: BuildMenuEntry[] } | null;
};

export type ActionMenuEntry = {
  label: 'Attack' | 'Capture' | 'Wait';
  enabled: boolean;
};

export type BuildMenuEntry = {
  unitType: UnitType;
  label: string;
  cost: number;
  affordable: boolean;
};

export type Viewport = {
  width: number; // CSS pixels
  height: number;
  dpr: number;
  tileSize: number;
  origin: { x: number; y: number }; // top-left of grid in CSS pixels
};

// ─────────────────────────── Public renderer API ─────────────────────────────

export type CanvasRenderer = {
  readonly canvas: HTMLCanvasElement;
  resize(): Viewport;
  /** Render the full frame given current state + overlay. */
  draw(state: GameState, overlay: Overlay, anim: AnimationQueue): void;
  /** CSS-pixel → tile coord. Returns null if outside the grid. */
  pixelToTile(px: number, py: number): Coord | null;
  /** Tile coord → top-left of tile in CSS pixels. */
  tileToPixel(c: Coord): { x: number; y: number };
  /** Current viewport metrics from the last resize. */
  getViewport(): Viewport;
  /** End-turn button hit rect (CSS pixels). */
  getEndTurnRect(): { x: number; y: number; w: number; h: number };
};

export function createCanvasRenderer(canvas: HTMLCanvasElement): CanvasRenderer {
  let viewport: Viewport = computeViewport(canvas);

  function computeViewport(c: HTMLCanvasElement): Viewport {
    const dpr = window.devicePixelRatio || 1;
    // jsdom sometimes has 0 inner sizes — fall back to a sensible default.
    const w = window.innerWidth || 1024;
    const h = window.innerHeight || 768;
    const tileSize = w < MOBILE_BREAKPOINT ? TILE_SIZE_MOBILE : TILE_SIZE_DESKTOP;
    c.width = Math.max(1, Math.floor(w * dpr));
    c.height = Math.max(1, Math.floor(h * dpr));
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    // Origin set when we know the map size — recomputed each draw.
    return { width: w, height: h, dpr, tileSize, origin: { x: 0, y: 0 } };
  }

  function originFor(state: GameState, vp: Viewport): { x: number; y: number } {
    const map = state.map;
    const rows = map.length;
    const cols = map[0]?.length ?? 0;
    const gridW = cols * vp.tileSize;
    const gridH = rows * vp.tileSize;
    const x = Math.floor((vp.width - gridW) / 2);
    // Push grid down to leave room for the HUD.
    const y = Math.max(HUD_HEIGHT + 8, Math.floor((vp.height - gridH) / 2));
    return { x, y };
  }

  function resize(): Viewport {
    viewport = computeViewport(canvas);
    return viewport;
  }

  function pixelToTile(px: number, py: number): Coord | null {
    const vp = viewport;
    const { x: ox, y: oy } = vp.origin;
    if (px < ox || py < oy) return null;
    const tx = Math.floor((px - ox) / vp.tileSize);
    const ty = Math.floor((py - oy) / vp.tileSize);
    if (tx < 0 || ty < 0) return null;
    return { x: tx, y: ty };
  }

  function tileToPixel(c: Coord): { x: number; y: number } {
    const vp = viewport;
    return {
      x: vp.origin.x + c.x * vp.tileSize,
      y: vp.origin.y + c.y * vp.tileSize,
    };
  }

  function draw(state: GameState, overlay: Overlay, anim: AnimationQueue): void {
    const vp = viewport;
    vp.origin = originFor(state, vp);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
    ctx.clearRect(0, 0, vp.width, vp.height);

    // Backdrop.
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, vp.width, vp.height);

    drawTerrain(ctx, state, vp);
    drawOwnerIndicators(ctx, state, vp);
    drawOverlays(ctx, vp, overlay);
    drawUnits(ctx, state, vp, anim, overlay);
    drawWinnerBanner(ctx, state, vp);
  }

  return {
    canvas,
    resize,
    draw,
    pixelToTile,
    tileToPixel,
    getViewport(): Viewport {
      return viewport;
    },
    getEndTurnRect(): { x: number; y: number; w: number; h: number } {
      const w = 140;
      const h = 36;
      return {
        x: viewport.width - w - 16,
        y: viewport.height - h - 16,
        w,
        h,
      };
    },
  };
}

// ─────────────────────────── Drawing primitives ──────────────────────────────

function drawTerrain(
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

      let fill: string = TERRAIN_FILL[tile.terrain];
      if (tile.terrain === 'hq') {
        if (tile.owner === 0) fill = '#d6a830';
        else if (tile.owner === 1) fill = '#3a78d6';
        else fill = NEUTRAL_HQ_OWNER_FILL;
      }
      ctx.fillStyle = fill;
      ctx.fillRect(px, py, ts, ts);

      // Forest pattern: a few darker dots.
      if (tile.terrain === 'forest') {
        ctx.fillStyle = '#2a4a28';
        const r = Math.max(1, Math.floor(ts / 12));
        ctx.beginPath();
        ctx.arc(px + ts * 0.3, py + ts * 0.35, r, 0, Math.PI * 2);
        ctx.arc(px + ts * 0.7, py + ts * 0.5, r, 0, Math.PI * 2);
        ctx.arc(px + ts * 0.45, py + ts * 0.75, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // Mountain shading: triangle peak overlay.
      if (tile.terrain === 'mountain') {
        ctx.fillStyle = '#5a3a1f';
        ctx.beginPath();
        ctx.moveTo(px + ts * 0.5, py + ts * 0.2);
        ctx.lineTo(px + ts * 0.85, py + ts * 0.8);
        ctx.lineTo(px + ts * 0.15, py + ts * 0.8);
        ctx.closePath();
        ctx.fill();
      }
      // Terrain letter.
      const letter = TERRAIN_LETTER[tile.terrain];
      if (letter) {
        ctx.fillStyle = TERRAIN_LETTER_COLOUR[tile.terrain];
        ctx.font = `600 ${Math.floor(ts * 0.28)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(letter, px + ts / 2, py + ts / 2 + ts * 0.02);
      }
      // Grid line.
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, ts - 1, ts - 1);
    }
  }
}

function drawOwnerIndicators(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  vp: Viewport,
): void {
  const map = state.map;
  for (let y = 0; y < map.length; y++) {
    const row = map[y]!;
    for (let x = 0; x < row.length; x++) {
      const tile = row[x]!;
      if (tile.owner === null || tile.terrain === 'hq') continue; // HQ shows ownership via fill
      const px = vp.origin.x + x * vp.tileSize;
      const py = vp.origin.y + y * vp.tileSize;
      const ts = vp.tileSize;
      ctx.fillStyle = OWNER_INDICATOR[tile.owner];
      const flagW = Math.max(4, Math.floor(ts * 0.18));
      ctx.fillRect(px + ts - flagW - 4, py + 4, flagW, flagW);
    }
  }
}

function drawOverlays(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  overlay: Overlay,
): void {
  const ts = vp.tileSize;
  // Capturable hint (faintest).
  for (const c of overlay.capturable ?? []) {
    fillTile(ctx, vp, c, 'rgba(255, 255, 120, 0.22)');
  }
  // Move range (blue alpha 0.3).
  for (const c of overlay.moveRange ?? []) {
    fillTile(ctx, vp, c, 'rgba(60, 120, 230, 0.30)');
  }
  // Attack range (red).
  for (const c of overlay.attackRange ?? []) {
    fillTile(ctx, vp, c, 'rgba(220, 60, 60, 0.34)');
  }
  // Move-preview path.
  for (const c of overlay.movePath ?? []) {
    fillTile(ctx, vp, c, 'rgba(255, 220, 80, 0.45)');
  }
  // Selected unit border.
  if (overlay.selected) {
    const px = vp.origin.x + overlay.selected.x * ts;
    const py = vp.origin.y + overlay.selected.y * ts;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffd84a';
    ctx.strokeRect(px + 2, py + 2, ts - 4, ts - 4);
  }
}

function fillTile(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  c: Coord,
  fill: string,
): void {
  const ts = vp.tileSize;
  const px = vp.origin.x + c.x * ts;
  const py = vp.origin.y + c.y * ts;
  ctx.fillStyle = fill;
  ctx.fillRect(px, py, ts, ts);
}

function drawUnits(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  vp: Viewport,
  anim: AnimationQueue,
  overlay: Overlay,
): void {
  const ts = vp.tileSize;
  const active = anim.active();
  const moveAnimById = new Map<string, Anim>();
  const attackerIds = new Set<string>();
  const flashTargetIds = new Set<string>();
  for (const a of active) {
    if (a.kind === 'move') moveAnimById.set(a.unitId, a);
    if (a.kind === 'attack') {
      attackerIds.add(a.attackerId);
      flashTargetIds.add(a.targetId);
    }
  }

  for (const unit of Object.values(state.units)) {
    drawUnit(ctx, state, vp, unit, moveAnimById.get(unit.id), attackerIds.has(unit.id), flashTargetIds.has(unit.id));
  }

  // Death animations: render the (now-deleted) unit fading on its last tile.
  for (const a of active) {
    if (a.kind !== 'death') continue;
    const elapsed = performance.now() - a.startMs;
    const t = Math.max(0, Math.min(1, elapsed / a.durationMs));
    ctx.globalAlpha = 1 - t;
    const px = vp.origin.x + a.pos.x * ts + 4;
    const py = vp.origin.y + a.pos.y * ts + 4;
    ctx.fillStyle = '#888';
    ctx.fillRect(px, py, ts - 8, ts - 8);
    ctx.globalAlpha = 1;
  }

  // Damage preview tooltip.
  if (overlay.damagePreview) {
    drawDamagePreview(ctx, vp, overlay.damagePreview);
  }
}

function drawUnit(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  vp: Viewport,
  unit: Unit,
  moveAnim: Anim | undefined,
  isAttacking: boolean,
  isFlashing: boolean,
): void {
  const ts = vp.tileSize;
  // Resolve render position — interpolate along the move path if mid-animation.
  let renderX: number;
  let renderY: number;
  if (moveAnim && moveAnim.kind === 'move') {
    const t = Math.max(
      0,
      Math.min(1, (performance.now() - moveAnim.startMs) / moveAnim.durationMs),
    );
    const path = moveAnim.path;
    if (path.length === 0) {
      const p = tileTopLeft(vp, unit.pos);
      renderX = p.x;
      renderY = p.y;
    } else {
      // Walk along the path proportionally.
      const totalSegs = path.length - 1;
      if (totalSegs <= 0) {
        const p0 = tileTopLeft(vp, path[0]!);
        renderX = p0.x;
        renderY = p0.y;
      } else {
        const segIdxRaw = t * totalSegs;
        const segIdx = Math.min(totalSegs - 1, Math.floor(segIdxRaw));
        const localT = segIdxRaw - segIdx;
        const a = path[segIdx]!;
        const b = path[segIdx + 1]!;
        const pa = tileTopLeft(vp, a);
        const pb = tileTopLeft(vp, b);
        renderX = pa.x + (pb.x - pa.x) * localT;
        renderY = pa.y + (pb.y - pa.y) * localT;
      }
    }
  } else {
    const p = tileTopLeft(vp, unit.pos);
    renderX = p.x;
    renderY = p.y;
  }

  // Attack shake: small horizontal jitter for the attacker.
  if (isAttacking) {
    const jitter = Math.sin(performance.now() * 0.08) * (ts * 0.06);
    renderX += jitter;
  }

  const palette = PLAYER_COLOURS[unit.owner];
  const inset = Math.max(3, Math.floor(ts * 0.12));
  const size = ts - inset * 2;
  ctx.fillStyle = palette.fill;
  ctx.fillRect(renderX + inset, renderY + inset, size, size);

  // Flash overlay on hit defender.
  if (isFlashing) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(renderX + inset, renderY + inset, size, size);
  }

  // Greyed if the unit has acted (visual hint for hot-seat play).
  if (unit.hasMoved && unit.hasActed) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(renderX + inset, renderY + inset, size, size);
  }

  // Letter.
  ctx.fillStyle = palette.letter;
  ctx.font = `bold ${Math.floor(ts * 0.45)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    UNIT_LETTER[unit.type],
    renderX + ts / 2,
    renderY + ts / 2 + ts * 0.02,
  );

  // HP bar if damaged.
  if (unit.hp < 100) {
    const segments = Math.max(1, Math.ceil(unit.hp / 10));
    const barH = Math.max(3, Math.floor(ts * 0.1));
    const barY = renderY + ts - barH - 2;
    const barW = ts - 6;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(renderX + 3, barY, barW, barH);
    const filled = (segments / 10) * barW;
    ctx.fillStyle = segments >= 6 ? '#7ed957' : segments >= 3 ? '#ffd84a' : '#ff5050';
    ctx.fillRect(renderX + 3, barY, filled, barH);
  }

  // Capture progress: tiny coloured pip on top-left.
  if (unit.captureProgress > 0) {
    const tile = tileAt(state.map, unit.pos);
    void tile;
    ctx.fillStyle = '#ffd84a';
    const pipW = Math.max(3, Math.floor(ts * 0.18));
    ctx.fillRect(renderX + 3, renderY + 3, pipW, pipW);
    ctx.fillStyle = '#222';
    ctx.font = `bold ${Math.floor(ts * 0.18)}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(String(unit.captureProgress), renderX + 4, renderY + 3);
  }
}

function tileTopLeft(vp: Viewport, c: Coord): { x: number; y: number } {
  return {
    x: vp.origin.x + c.x * vp.tileSize,
    y: vp.origin.y + c.y * vp.tileSize,
  };
}

function drawDamagePreview(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  preview: { tile: Coord; dealt: number; received: number },
): void {
  const ts = vp.tileSize;
  const p = tileTopLeft(vp, preview.tile);
  const w = 130;
  const h = 44;
  let bx = p.x + ts + 6;
  let by = p.y - h - 6;
  // Keep on-screen.
  if (bx + w > vp.width - 8) bx = p.x - w - 6;
  if (by < HUD_HEIGHT + 4) by = p.y + ts + 6;
  ctx.fillStyle = 'rgba(20,20,20,0.92)';
  ctx.fillRect(bx, by, w, h);
  ctx.strokeStyle = '#ffd84a';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
  ctx.fillStyle = '#fff';
  ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`Dealt:     ${preview.dealt} HP`, bx + 8, by + 6);
  ctx.fillStyle = preview.received > 0 ? '#ff8888' : '#bbb';
  ctx.fillText(`Counter: ${preview.received} HP`, bx + 8, by + 24);
}

function drawWinnerBanner(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  vp: Viewport,
): void {
  if (state.winner === null) return;
  const w = 320;
  const h = 72;
  const x = (vp.width - w) / 2;
  const y = (vp.height - h) / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PLAYER_COLOURS[state.winner].fill;
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Player ${state.winner + 1} wins!`, x + w / 2, y + h / 2);
}

// Re-export for hud / input to share the same constants.
export function tileSizeFor(width: number): number {
  return width < MOBILE_BREAKPOINT ? TILE_SIZE_MOBILE : TILE_SIZE_DESKTOP;
}

export function isUnitAt(state: GameState, c: Coord): Unit | undefined {
  return unitAt(state, c);
}
