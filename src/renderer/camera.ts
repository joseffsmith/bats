// Board camera — the mobile board's owner of `tileSize` + `origin`.
//
// On desktop the renderer derives both every frame from the map size and the
// measured chrome insets (fitTileSize + originFor in canvas.ts): the whole board
// is always fitted into the gap between the bars, and there is nothing to pan.
// On mobile that's untenable — a 20×12 map fitted onto a 390px-wide phone lands
// at ~19px tiles, which is unreadable and untappable. So mobile hands ownership
// of the viewport transform to this module: the board renders at a *tactical*
// zoom (big enough to read and tap), extends past the screen edges, and the
// player pinches/drags it around.
//
// The renderer stays dumb. `canvas.ts` asks for `tileSize()` and `origin()` each
// frame and paints exactly as before; every drawing and hit-testing path already
// reads those two fields, so nothing else in the renderer needed to change.
//
// PURE BY CONSTRUCTION. The camera owns no DOM and reads no globals: the map
// dimensions and the CSS-pixel view size arrive through `deps`, and the only
// clock is the `nowMs` passed to `tick`. That is what makes the geometry — the
// clamps, the zoom-about-a-focal-point invariant, the pan bounds — unit-testable
// in a node environment (tests/camera.test.ts) rather than only observable
// through a browser.
//
// ── The band ────────────────────────────────────────────────────────────────
// `setBand(top, bottom)` reserves vertical space for the chrome (today the
// desktop header/footer, forwarded from the renderer's measured insets; later
// the mobile HUD strip and verb tray). Everything below is expressed against the
// resulting *band* — the visible rectangle the board should live in:
//
//     bandLeft = 0, bandRight = viewWidth
//     bandTop  = top,  bandBottom = viewHeight - bottom
//
// ── Zoom ────────────────────────────────────────────────────────────────────
// Clamped to [fit-whole-map, MAX_TILE]. The floor is "the whole map is visible
// inside the band" computed FULL-BLEED (no MARGIN gutter — that's the desktop
// frame's business, and mobile is frameless), so a player can always zoom out to
// exactly the overview and never further. Boot lands at MAX(fit, BOOT_TILE)
// centred on the player's HQ: a phone gets a readable tactical view, a tablet
// wide enough to fit the map at >56px just shows the map.
//
// ── Pan ─────────────────────────────────────────────────────────────────────
// Clamped per axis, independently, because a board is routinely wider than the
// band but shorter than it. Per axis: if the grid fits inside the band the
// position is LOCKED centred (you cannot drag a small board off-centre); if it
// doesn't, the board's edge may never cross inside the band (no dead space).
//
// ── Crispness ───────────────────────────────────────────────────────────────
// The renderer draws 1px grid/overlay contours on a 0.5px inset, which only
// lands on a physical pixel when `tileSize` and `origin` are integers. `origin()`
// is therefore always integer-rounded, and `settle()` — called by the gesture
// layer when fingers leave the glass — rounds `tileSize` to an integer too. A
// float tile size is allowed *during* a pinch, where smooth tracking of the
// fingers matters more than a hairline.

import type { Coord } from '../engine/core/types';
import { easeInOutCubic } from './easing';

// ─────────────────────────── Constants ───────────────────────────────────────

/** Zoom ceiling (CSS px per tile). Beyond this a phone shows ~4 tiles and the
 *  player loses all tactical context. */
export const MAX_TILE_SIZE = 90;

/** Preferred boot zoom (CSS px per tile) — raised to the fit size when the map
 *  already fits at more than this (tablets, tiny maps). Chosen so a 390px phone
 *  shows ~7 columns: enough context to plan, big enough to hit with a thumb. */
export const BOOT_TILE_SIZE = 56;

/** Duration of an animated `centerOn` (the AI auto-follow pan). */
const CENTER_MS = 250;

/** Tolerance (CSS px) for "is the current zoom the fit-whole-map zoom". */
const OVERVIEW_EPSILON = 0.5;

/** Fallback tile size when the map size is degenerate (0 cols/rows). */
const FALLBACK_TILE_SIZE = 48;

// ─────────────────────────── Types ───────────────────────────────────────────

export type CameraDeps = {
  /** Live map dimensions in tiles. Read fresh — the map can change under us
   *  (scenario injection, campaign level load) and the camera re-clamps. */
  getMapSize(): { cols: number; rows: number };
  /** Live viewport size in CSS pixels. */
  getViewSize(): { width: number; height: number };
  /**
   * Tile to centre on at boot (the current player's HQ). Read lazily on first
   * use, so the camera can be constructed before the game state settles.
   * Absent/null → centre the map.
   */
  getInitialFocus?: () => Coord | null;
};

export type Camera = {
  /** Tile edge in CSS px. Float mid-gesture, integer once `settle()` has run. */
  tileSize(): number;
  /** Top-left of the grid in CSS px, integer-rounded for crisp 0.5px lines. */
  origin(): { x: number; y: number };
  /**
   * Zoom to `ts` CSS px per tile, keeping the world point currently under
   * `focus` (a CSS-px point — a pinch midpoint) pinned under it. Defaults to
   * the band centre. Clamped to [fit-whole-map, MAX_TILE_SIZE].
   */
  setZoom(ts: number, focus?: { x: number; y: number }): void;
  /** Drag the board by a CSS-px delta. Clamped per axis. */
  panBy(dx: number, dy: number): void;
  /** Centre the band on a tile. `animate` eases over ~250ms via `tick`. */
  centerOn(tile: Coord, animate?: boolean): void;
  /** Zoom out to show the whole map inside the band. */
  fitMap(): void;
  /** Overview (fit-map) ↔ the tactical zoom the player was last at. */
  toggleOverview(): void;
  /** True iff the current zoom is the fit-whole-map zoom. */
  isOverview(): boolean;
  /** Advance time-driven state (the animated `centerOn`) and re-clamp. */
  tick(nowMs: number): void;
  /** Reserve `top`/`bottom` CSS px of chrome. See "The band" above. */
  setBand(top: number, bottom: number): void;
  /** Re-clamp after a viewport resize. */
  resize(): void;
  /** Round `tileSize` to an integer (gesture end) so hairlines land on pixels. */
  settle(): void;
};

type PanTween = {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** Stamped by the first `tick` that sees it, so the camera needs no clock. */
  startMs: number | null;
  durMs: number;
};

// ─────────────────────────── Factory ─────────────────────────────────────────

export function createCamera(deps: CameraDeps): Camera {
  /** Tile edge in CSS px. Float while a pinch is in flight. */
  let ts = BOOT_TILE_SIZE;
  /** Grid top-left in CSS px. Float; rounded only on read. */
  let ox = 0;
  let oy = 0;
  /** Reserved chrome heights. Corrected from the measured insets on mount. */
  let bandTopInset = 0;
  let bandBottomInset = 0;
  /**
   * Deferred boot. The camera is constructed before the chrome has measured
   * itself, so the fit/HQ-centre maths would run against the wrong band. Instead
   * the first read (which happens inside the render loop, after chrome mount)
   * performs it. `resize`/`setBand` deliberately no-op until then rather than
   * initialising early with stale numbers.
   */
  let initialised = false;
  /** Zoom to restore when leaving overview. */
  let tacticalTs = BOOT_TILE_SIZE;
  let tween: PanTween | null = null;

  // ── Geometry ───────────────────────────────────────────────────────────────

  type Band = {
    cols: number;
    rows: number;
    width: number;
    height: number;
    top: number;
    bottom: number; // absolute y of the band's bottom edge
    bw: number;
    bh: number;
  };

  function band(): Band {
    const { cols, rows } = deps.getMapSize();
    const { width, height } = deps.getViewSize();
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    let top = Math.max(0, bandTopInset);
    let bottom = Math.max(0, bandBottomInset);
    // Degenerate chrome (mis-measured, or taller than the screen) would produce
    // a zero/negative band and poison every ratio below. Fall back to full-bleed.
    if (top + bottom >= h) {
      top = 0;
      bottom = 0;
    }
    return {
      cols,
      rows,
      width: w,
      height: h,
      top,
      bottom: h - bottom,
      bw: w,
      bh: h - top - bottom,
    };
  }

  /** Tile size at which the whole map exactly fills the band (no margin). */
  function fitTileSize(b: Band): number {
    if (b.cols <= 0 || b.rows <= 0) return FALLBACK_TILE_SIZE;
    return Math.min(b.bw / b.cols, b.bh / b.rows);
  }

  /** Zoom floor: the fit size, but never above the ceiling (tiny maps on big
   *  screens fit at >MAX, which would invert the clamp range). */
  function minTileSize(b: Band): number {
    return Math.min(fitTileSize(b), MAX_TILE_SIZE);
  }

  function clampTileSize(t: number, b: Band): number {
    if (!Number.isFinite(t)) return minTileSize(b);
    return Math.max(minTileSize(b), Math.min(MAX_TILE_SIZE, t));
  }

  /**
   * Pan clamp, per axis and independent: a board is routinely wider than the
   * band but shorter than it. Grid fits → LOCKED centred. Grid overflows → the
   * board's edges may not cross inside the band.
   */
  function clampOrigin(x: number, y: number, t: number, b: Band): { x: number; y: number } {
    const gridW = b.cols * t;
    const gridH = b.rows * t;
    const nx =
      gridW <= b.bw
        ? (b.bw - gridW) / 2
        : Math.max(b.width - gridW, Math.min(0, x));
    const ny =
      gridH <= b.bh
        ? b.top + (b.bh - gridH) / 2
        : Math.max(b.bottom - gridH, Math.min(b.top, y));
    return { x: nx, y: ny };
  }

  function bandCentre(b: Band): { x: number; y: number } {
    return { x: b.width / 2, y: b.top + b.bh / 2 };
  }

  /** Origin that puts `tile`'s centre at the band's centre (clamped). */
  function centreTarget(tile: Coord, t: number, b: Band): { x: number; y: number } {
    const c = bandCentre(b);
    return clampOrigin(c.x - (tile.x + 0.5) * t, c.y - (tile.y + 0.5) * t, t, b);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  function ensureInit(): void {
    if (initialised) return;
    initialised = true;
    const b = band();
    ts = clampTileSize(BOOT_TILE_SIZE, b);
    tacticalTs = ts;
    const focus =
      deps.getInitialFocus?.() ?? { x: (b.cols - 1) / 2, y: (b.rows - 1) / 2 };
    const p = centreTarget(focus, ts, b);
    ox = p.x;
    oy = p.y;
  }

  /** Re-apply both clamps against the CURRENT map + view. Absorbs a map swap
   *  (scenario injection) or a viewport change without any explicit notice. */
  function reclamp(): void {
    const b = band();
    ts = clampTileSize(ts, b);
    const p = clampOrigin(ox, oy, ts, b);
    ox = p.x;
    oy = p.y;
  }

  // ── API ────────────────────────────────────────────────────────────────────

  function setZoom(next: number, focus?: { x: number; y: number }): void {
    ensureInit();
    const b = band();
    const t0 = clampTileSize(ts, b);
    const t1 = clampTileSize(next, b);
    const f = focus ?? bandCentre(b);
    // The world point (in tile units) currently under the focal point. Pinning
    // it across the zoom is what makes a pinch feel attached to the fingers.
    const wx = (f.x - ox) / t0;
    const wy = (f.y - oy) / t0;
    ts = t1;
    const p = clampOrigin(f.x - wx * t1, f.y - wy * t1, t1, b);
    ox = p.x;
    oy = p.y;
    // A deliberate zoom supersedes an in-flight auto-follow pan.
    tween = null;
  }

  function panBy(dx: number, dy: number): void {
    ensureInit();
    const b = band();
    ts = clampTileSize(ts, b);
    const p = clampOrigin(ox + dx, oy + dy, ts, b);
    ox = p.x;
    oy = p.y;
    tween = null;
  }

  function centerOn(tile: Coord, animate?: boolean): void {
    ensureInit();
    const b = band();
    ts = clampTileSize(ts, b);
    const target = centreTarget(tile, ts, b);
    if (animate !== true) {
      ox = target.x;
      oy = target.y;
      tween = null;
      return;
    }
    tween = {
      fromX: ox,
      fromY: oy,
      toX: target.x,
      toY: target.y,
      startMs: null,
      durMs: CENTER_MS,
    };
  }

  function fitMap(): void {
    ensureInit();
    const b = band();
    ts = clampTileSize(fitTileSize(b), b);
    const p = clampOrigin(ox, oy, ts, b);
    ox = p.x;
    oy = p.y;
    tween = null;
  }

  function isOverview(): boolean {
    if (!initialised) return false;
    const b = band();
    return Math.abs(clampTileSize(ts, b) - clampTileSize(fitTileSize(b), b)) < OVERVIEW_EPSILON;
  }

  function toggleOverview(): void {
    ensureInit();
    if (isOverview()) {
      setZoom(tacticalTs);
      return;
    }
    tacticalTs = ts;
    fitMap();
  }

  return {
    tileSize(): number {
      ensureInit();
      return clampTileSize(ts, band());
    },
    origin(): { x: number; y: number } {
      ensureInit();
      const b = band();
      const p = clampOrigin(ox, oy, clampTileSize(ts, b), b);
      return { x: Math.round(p.x), y: Math.round(p.y) };
    },
    setZoom,
    panBy,
    centerOn,
    fitMap,
    toggleOverview,
    isOverview,
    tick(nowMs: number): void {
      ensureInit();
      if (tween) {
        // Stamp on first sight rather than at creation so the camera never has
        // to own a clock (and tests can drive it with plain numbers).
        if (tween.startMs === null) tween.startMs = nowMs;
        const raw = tween.durMs <= 0 ? 1 : (nowMs - tween.startMs) / tween.durMs;
        const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
        const e = easeInOutCubic(t);
        // Both endpoints are clamped and the valid region is a box (convex), so
        // every interpolated point is in-bounds by construction.
        ox = tween.fromX + (tween.toX - tween.fromX) * e;
        oy = tween.fromY + (tween.toY - tween.fromY) * e;
        if (t >= 1) tween = null;
      }
      reclamp();
    },
    setBand(top: number, bottom: number): void {
      bandTopInset = Math.max(0, top);
      bandBottomInset = Math.max(0, bottom);
      // Before boot the band is just recorded — `ensureInit` will read it.
      if (initialised) reclamp();
    },
    resize(): void {
      if (initialised) reclamp();
    },
    settle(): void {
      ensureInit();
      const b = band();
      const floor = minTileSize(b);
      let r = Math.round(clampTileSize(ts, b));
      // Rounding DOWN through the floor would be clamped straight back to a
      // fractional size, defeating the point — step up to the next integer.
      if (r < floor) r = Math.ceil(floor);
      if (r > MAX_TILE_SIZE) r = MAX_TILE_SIZE;
      setZoom(r);
    },
  };
}
