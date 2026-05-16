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
  Unit,
  UnitType,
} from '../engine/core/types';
import { tileAt, unitAt } from '../engine/core/types';
import type { AnimationQueue, Anim } from './animations';
import { easeInOutCubic } from './easing';
import type { SpriteCache } from './sprites';
import { PLAYER_COLOURS } from './canvas-palette';
import { drawTerrain } from './terrain';
export type { PlayerPalette } from './canvas-palette';
export { PLAYER_COLOURS };

// ─────────────────────────── Constants ───────────────────────────────────────

export const TILE_SIZE_DESKTOP = 48;
export const TILE_SIZE_MOBILE = 32;
export const MOBILE_BREAKPOINT = 768;

/** Vertical space reserved at the top of the canvas for the DOM chrome
 *  (mirrored player HUDs + turn indicator). */
export const BOARD_TOP_INSET = 110;

/** Vertical space reserved at the bottom of the canvas for the DOM chrome
 *  (toolshelf + AI config + end-turn cluster). */
export const BOARD_BOTTOM_INSET = 110;

const UNIT_LETTER: Record<UnitType, string> = {
  infantry: 'I',
  recon: 'R',
  tank: 'T',
  artillery: 'A',
  copter: 'C',
  transport: 'X',
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
  label: 'Attack' | 'Capture' | 'Wait' | 'Unload';
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

export type CanvasRendererDeps = {
  /** Optional procedurally-baked sprite cache. If absent, units fall back to the
   *  coloured-square renderer (used by tests with stub contexts). */
  sprites?: SpriteCache;
};

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
};

export function createCanvasRenderer(
  canvas: HTMLCanvasElement,
  deps: CanvasRendererDeps = {},
): CanvasRenderer {
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
    // Centre the grid inside the chrome-bounded area: between BOARD_TOP_INSET
    // and (height - BOARD_BOTTOM_INSET). Clamp to never overlap the top chrome.
    const usableH = vp.height - BOARD_TOP_INSET - BOARD_BOTTOM_INSET;
    const y = Math.max(
      BOARD_TOP_INSET + 8,
      BOARD_TOP_INSET + Math.floor((usableH - gridH) / 2),
    );
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
    // Transparent clear — the body background (warm dark + noise) shows
    // through, unifying the canvas with the DOM chrome.
    ctx.clearRect(0, 0, vp.width, vp.height);

    // Apply camera shake: translate the drawing transform a couple pixels so
    // big-damage hits feel impactful. We add to the dpr-scaled transform.
    const shake = anim.shakeOffset();
    if (shake.dx !== 0 || shake.dy !== 0) {
      ctx.setTransform(
        vp.dpr,
        0,
        0,
        vp.dpr,
        Math.round(shake.dx * vp.dpr),
        Math.round(shake.dy * vp.dpr),
      );
    }

    drawBoardFrame(ctx, state, vp);
    drawTerrain(ctx, state, vp);
    drawOverlays(ctx, vp, overlay);
    drawUnits(ctx, state, vp, anim, overlay, deps.sprites);
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
  };
}

// ─────────────────────────── Drawing primitives ──────────────────────────────

/** Warm bezel + corner brackets around the grid bounds. Matches the DOM
 *  chrome's almanac aesthetic. */
function drawBoardFrame(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  vp: Viewport,
): void {
  const map = state.map;
  const cols = map[0]?.length ?? 0;
  const rows = map.length;
  const gridW = cols * vp.tileSize;
  const gridH = rows * vp.tileSize;
  const ox = vp.origin.x;
  const oy = vp.origin.y;
  const pad = 14;
  const fx = ox - pad;
  const fy = oy - pad;
  const fw = gridW + pad * 2;
  const fh = gridH + pad * 2;

  // Drop shadow.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 12;
  // Frame body — warm diagonal gradient.
  const grad = ctx.createLinearGradient(fx, fy, fx, fy + fh);
  grad.addColorStop(0, '#3a3024');
  grad.addColorStop(1, '#2a2419');
  ctx.fillStyle = grad;
  ctx.fillRect(fx, fy, fw, fh);
  ctx.restore();

  // Inner highlight rule (gold).
  ctx.strokeStyle = 'rgba(212, 168, 87, 0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);

  // Corner brackets.
  ctx.strokeStyle = 'rgba(212, 168, 87, 0.55)';
  ctx.lineWidth = 1;
  const armLen = 14;
  const inset = 5;
  // top-left
  bracket(ctx, fx + inset, fy + inset, armLen, armLen);
  // top-right
  bracket(ctx, fx + fw - inset, fy + inset, -armLen, armLen);
  // bottom-left
  bracket(ctx, fx + inset, fy + fh - inset, armLen, -armLen);
  // bottom-right
  bracket(ctx, fx + fw - inset, fy + fh - inset, -armLen, -armLen);
}

function bracket(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dx: number,
  dy: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + dx, y + 0.5);
  ctx.lineTo(x + 0.5, y + 0.5);
  ctx.lineTo(x + 0.5, y + dy);
  ctx.stroke();
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
  sprites: SpriteCache | undefined,
): void {
  const ts = vp.tileSize;
  const active = anim.active();
  const moveAnimById = new Map<string, Anim>();
  const attackerIds = new Set<string>();
  const flashTargetIds = new Set<string>();
  const hpTweenById = new Map<string, Anim>();
  for (const a of active) {
    if (a.kind === 'move') moveAnimById.set(a.unitId, a);
    if (a.kind === 'attack') {
      attackerIds.add(a.attackerId);
      flashTargetIds.add(a.targetId);
    }
    if (a.kind === 'hpTween') hpTweenById.set(a.unitId, a);
  }

  for (const unit of Object.values(state.units)) {
    // Loaded cargo isn't drawn separately — its carrier renders a cargo
    // badge instead.
    if (unit.loadedIn !== undefined) continue;
    drawUnit(
      ctx,
      state,
      vp,
      unit,
      moveAnimById.get(unit.id),
      attackerIds.has(unit.id),
      flashTargetIds.has(unit.id) ? anim.flashIntensity(unit.id) : 0,
      hpTweenById.get(unit.id),
      sprites,
    );
  }

  // Death animations: render the (now-deleted) unit fading + a small radial
  // particle explosion on its last tile.
  for (const a of active) {
    if (a.kind !== 'death') continue;
    const elapsed = performance.now() - a.startMs;
    const t = Math.max(0, Math.min(1, elapsed / a.durationMs));
    const px = vp.origin.x + a.pos.x * ts;
    const py = vp.origin.y + a.pos.y * ts;
    // Fade + slight scale-down of the underlying silhouette.
    ctx.save();
    ctx.globalAlpha = 1 - t;
    const scale = 1 - t * 0.3;
    const inset = (ts - ts * scale) / 2;
    ctx.fillStyle = '#888';
    ctx.fillRect(px + inset + 4, py + inset + 4, ts * scale - 8, ts * scale - 8);
    ctx.restore();
    // Particles. Each gets a velocity from createDeathParticles; we integrate
    // over `elapsed/1000` seconds, multiplied by tileSize for pixel-space.
    ctx.save();
    const seconds = elapsed / 1000;
    for (const p of a.particles) {
      const cx = px + p.ox * ts + p.vx * seconds * ts;
      const cy = py + p.oy * ts + p.vy * seconds * ts;
      const r = Math.max(1, ts * 0.06 * (1 - t));
      ctx.globalAlpha = Math.max(0, 1 - t);
      // Hot core fading to dark.
      const heat = 1 - t;
      const colour = heat > 0.5 ? '#ffd84a' : '#ff7a40';
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
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
  flashIntensity: number,
  hpTween: Anim | undefined,
  sprites: SpriteCache | undefined,
): void {
  const ts = vp.tileSize;
  // Resolve render position — interpolate along the move path if mid-animation.
  let renderX: number;
  let renderY: number;
  if (moveAnim && moveAnim.kind === 'move') {
    const tRaw = Math.max(
      0,
      Math.min(1, (performance.now() - moveAnim.startMs) / moveAnim.durationMs),
    );
    // Phase 6 polish: ease the full-path interpolant.
    const t = easeInOutCubic(tRaw);
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

  // Attack lunge: short horizontal jitter for the attacker. The amplitude is
  // small (~6% of tile size) so it reads as "pushing forward" rather than
  // jittering in place. Camera shake handles the impact feel.
  if (isAttacking) {
    const jitter = Math.sin(performance.now() * 0.08) * (ts * 0.06);
    renderX += jitter;
  }

  const palette = PLAYER_COLOURS[unit.owner];
  const inset = Math.max(3, Math.floor(ts * 0.12));
  const size = ts - inset * 2;

  // ── Body draw: sprite if available, else coloured rectangle fallback. ──
  let drewSprite = false;
  if (sprites) {
    try {
      const variant = unit.hp < 50 ? 'damaged' : 'clean';
      const img = sprites.get(unit.type, unit.owner, variant);
      ctx.drawImage(img, renderX, renderY, ts, ts);
      drewSprite = true;
    } catch {
      drewSprite = false;
    }
  }
  if (!drewSprite) {
    ctx.fillStyle = palette.fill;
    ctx.fillRect(renderX + inset, renderY + inset, size, size);
    // Letter only on the fallback path — sprites carry their own silhouette.
    ctx.fillStyle = palette.letter;
    ctx.font = `bold ${Math.floor(ts * 0.45)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(UNIT_LETTER[unit.type], renderX + ts / 2, renderY + ts / 2 + ts * 0.02);
  }

  // Flash overlay on hit defender. easeOutBack intensity reaches ~1.05 mid-
  // animation, producing an overshoot that snaps back to 0.
  if (flashIntensity > 0) {
    const a = Math.max(0, Math.min(0.85, 0.85 - flashIntensity * 0.7));
    if (a > 0) {
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.fillRect(renderX + inset, renderY + inset, size, size);
    }
  }

  // Greyed if the unit has acted (visual hint for hot-seat play).
  if (unit.hasMoved && unit.hasActed) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(renderX + inset, renderY + inset, size, size);
  }

  // HP bar if damaged. Tween between fromHp/toHp when an HP tween anim is
  // active for this unit so the bar slides rather than snapping.
  let displayHp = unit.hp;
  if (hpTween && hpTween.kind === 'hpTween') {
    const tt = Math.max(
      0,
      Math.min(1, (performance.now() - hpTween.startMs) / hpTween.durationMs),
    );
    displayHp = hpTween.fromHp + (hpTween.toHp - hpTween.fromHp) * easeInOutCubic(tt);
  }
  if (displayHp < 100) {
    const segments = Math.max(1, Math.ceil(displayHp / 10));
    const barH = Math.max(3, Math.floor(ts * 0.1));
    const barY = renderY + ts - barH - 2;
    const barW = ts - 6;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(renderX + 3, barY, barW, barH);
    const filled = Math.max(0, (displayHp / 100) * barW);
    ctx.fillStyle = segments >= 6 ? '#7ed957' : segments >= 3 ? '#ffd84a' : '#ff5050';
    ctx.fillRect(renderX + 3, barY, filled, barH);
  }

  // Cargo indicator: small filled dot on the top-right when a transport is
  // carrying at least one unit. Renders inside the unit cell so it's visible
  // even when sprites are missing (tests use blank sprites).
  if (unit.cargo && unit.cargo.length > 0) {
    const dotR = Math.max(3, Math.floor(ts * 0.10));
    const cx = renderX + ts - dotR - 4;
    const cy = renderY + dotR + 4;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#222';
    ctx.font = `bold ${Math.floor(ts * 0.18)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(unit.cargo.length), cx, cy + 1);
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
  if (by < BOARD_TOP_INSET + 4) by = p.y + ts + 6;
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
