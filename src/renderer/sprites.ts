// Procedurally generated unit sprites.
//
// Phase 6 replaces the coloured-square + letter rendering with small canonical
// silhouettes drawn at startup to offscreen canvases. The cache is keyed by
// `<type>-<player>` and looked up by drawUnit each frame. Sprites are sized
// to a `tileSize`-square plus a 1-tile shadow band.
//
// No external image assets are used — every pixel is drawn by `paint*`
// helpers below using plain canvas primitives. This keeps the bundle small
// and lets us tweak palette / detail later without re-baking PNGs.
//
// Damaged variants: when HP < 50 we draw one or two extra dark strokes
// ("dents/scratches") on top of the base sprite. We bake two sprite variants
// per (type, player): `clean` and `damaged`.

import type { PlayerId, UnitType } from '../engine/core/types';
import { PLAYER_COLOURS } from './canvas-palette';

/** Side length of the generated sprite, in CSS pixels. */
export const SPRITE_SIZE = 64;

export type SpriteVariant = 'clean' | 'damaged';

export type SpriteCache = {
  /** Look up a sprite. Returns the underlying canvas (drawable via drawImage). */
  get(type: UnitType, owner: PlayerId, variant: SpriteVariant): CanvasImageSource;
  /** Number of sprites baked. Useful for tests. */
  size(): number;
  /** Keys present in the cache. */
  keys(): string[];
};

function cacheKey(type: UnitType, owner: PlayerId, variant: SpriteVariant): string {
  return `${type}-${owner}-${variant}`;
}

type SpriteHost = HTMLCanvasElement | OffscreenCanvas;

function makeHost(): SpriteHost {
  // Prefer OffscreenCanvas — sprite drawing happens once at startup so the
  // tiny perf win matters less than not allocating a DOM element per sprite.
  // Fall back to a hidden <canvas> for environments without OffscreenCanvas.
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(SPRITE_SIZE, SPRITE_SIZE);
  }
  const c = document.createElement('canvas');
  c.width = SPRITE_SIZE;
  c.height = SPRITE_SIZE;
  return c;
}

function getCtx(host: SpriteHost): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
  const ctx = host.getContext('2d');
  return (ctx ?? null) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
}

const UNIT_TYPES: ReadonlyArray<UnitType> = [
  'infantry',
  'recon',
  'tank',
  'artillery',
  'copter',
  'transport',
  'fighter',
  'bomber',
  'battleship',
  'cruiser',
  'aatank',
  'lander',
];

const PLAYERS: ReadonlyArray<PlayerId> = [0, 1];
const VARIANTS: ReadonlyArray<SpriteVariant> = ['clean', 'damaged'];

export function createSpriteCache(): SpriteCache {
  const map = new Map<string, SpriteHost>();
  for (const type of UNIT_TYPES) {
    for (const owner of PLAYERS) {
      for (const variant of VARIANTS) {
        const host = makeHost();
        const ctx = getCtx(host);
        // In environments without a 2D context (e.g. JSDOM with no canvas
        // backend), we still register the host so the cache has entries.
        // The canvas renderer's `drawImage` fallback handles the empty bitmap
        // gracefully — it'll just paint an invisible sprite.
        if (ctx) paintSprite(ctx, type, owner, variant);
        map.set(cacheKey(type, owner, variant), host);
      }
    }
  }
  return {
    get(type, owner, variant): CanvasImageSource {
      const host = map.get(cacheKey(type, owner, variant));
      if (!host) throw new Error(`sprite missing: ${type}-${owner}-${variant}`);
      return host as CanvasImageSource;
    },
    size(): number {
      return map.size;
    },
    keys(): string[] {
      return Array.from(map.keys());
    },
  };
}

// ─────────────────────────── Paint routines ──────────────────────────────────

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function paintSprite(ctx: Ctx, type: UnitType, owner: PlayerId, variant: SpriteVariant): void {
  const palette = PLAYER_COLOURS[owner];
  // Backdrop is transparent; we paint a soft drop-shadow ellipse for grounding.
  ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  paintShadow(ctx);
  // Body fill colour comes from the player palette; details are a darker tone.
  const body = palette.fill;
  const dark = darken(body, 0.35);
  const light = lighten(body, 0.25);
  const detail = palette.letter;
  switch (type) {
    case 'infantry':
      paintInfantry(ctx, body, dark, light, detail);
      break;
    case 'recon':
      paintRecon(ctx, body, dark, light);
      break;
    case 'tank':
      paintTank(ctx, body, dark, light);
      break;
    case 'artillery':
      paintArtillery(ctx, body, dark, light);
      break;
    case 'copter':
      paintCopter(ctx, body, dark, light, detail);
      break;
    case 'transport':
      paintTransport(ctx, body, dark, light);
      break;
    case 'fighter':
      paintFighter(ctx, body, dark, light, detail);
      break;
    case 'bomber':
      paintBomber(ctx, body, dark, light, detail);
      break;
    case 'battleship':
      paintBattleship(ctx, body, dark, light);
      break;
    case 'cruiser':
      paintCruiser(ctx, body, dark, light);
      break;
    case 'aatank':
      paintAATank(ctx, body, dark, light);
      break;
    case 'lander':
      paintLander(ctx, body, dark, light);
      break;
  }
  if (variant === 'damaged') paintDents(ctx);
}

function paintShadow(ctx: Ctx): void {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.beginPath();
  // Ellipse: width 70% of sprite, height 10%, centred near the bottom.
  ctx.ellipse(
    SPRITE_SIZE * 0.5,
    SPRITE_SIZE * 0.86,
    SPRITE_SIZE * 0.32,
    SPRITE_SIZE * 0.06,
    0,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.restore();
}

function paintInfantry(ctx: Ctx, body: string, dark: string, light: string, detail: string): void {
  const S = SPRITE_SIZE;
  // Body torso.
  ctx.fillStyle = body;
  roundedRect(ctx, S * 0.34, S * 0.42, S * 0.32, S * 0.36, 4);
  ctx.fill();
  // Helmet.
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.arc(S * 0.5, S * 0.34, S * 0.13, Math.PI, 0);
  ctx.lineTo(S * 0.63, S * 0.36);
  ctx.lineTo(S * 0.37, S * 0.36);
  ctx.closePath();
  ctx.fill();
  // Helmet rim highlight.
  ctx.strokeStyle = light;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(S * 0.37, S * 0.35);
  ctx.lineTo(S * 0.63, S * 0.35);
  ctx.stroke();
  // Detail strap (chin).
  ctx.fillStyle = detail;
  ctx.fillRect(S * 0.47, S * 0.4, S * 0.06, S * 0.04);
  // Rifle slung diagonally.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(S * 0.62, S * 0.5);
  ctx.lineTo(S * 0.74, S * 0.7);
  ctx.stroke();
}

function paintRecon(ctx: Ctx, body: string, dark: string, light: string): void {
  const S = SPRITE_SIZE;
  // Wheeled vehicle: short body, two visible wheels, low silhouette.
  ctx.fillStyle = body;
  roundedRect(ctx, S * 0.18, S * 0.48, S * 0.64, S * 0.24, 4);
  ctx.fill();
  // Cab / window strip.
  ctx.fillStyle = light;
  roundedRect(ctx, S * 0.46, S * 0.42, S * 0.30, S * 0.14, 2);
  ctx.fill();
  // Hood line.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(S * 0.46, S * 0.56);
  ctx.lineTo(S * 0.78, S * 0.56);
  ctx.stroke();
  // Wheels.
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.arc(S * 0.3, S * 0.74, S * 0.09, 0, Math.PI * 2);
  ctx.arc(S * 0.7, S * 0.74, S * 0.09, 0, Math.PI * 2);
  ctx.fill();
  // Wheel hubs.
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.arc(S * 0.3, S * 0.74, S * 0.03, 0, Math.PI * 2);
  ctx.arc(S * 0.7, S * 0.74, S * 0.03, 0, Math.PI * 2);
  ctx.fill();
}

function paintTank(ctx: Ctx, body: string, dark: string, light: string): void {
  const S = SPRITE_SIZE;
  // Tracks (dark slabs along bottom).
  ctx.fillStyle = dark;
  roundedRect(ctx, S * 0.14, S * 0.66, S * 0.72, S * 0.16, 3);
  ctx.fill();
  // Track treads — short ticks.
  ctx.strokeStyle = light;
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    const tx = S * 0.18 + i * S * 0.12;
    ctx.beginPath();
    ctx.moveTo(tx, S * 0.7);
    ctx.lineTo(tx, S * 0.78);
    ctx.stroke();
  }
  // Hull.
  ctx.fillStyle = body;
  roundedRect(ctx, S * 0.18, S * 0.5, S * 0.64, S * 0.2, 4);
  ctx.fill();
  // Turret.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(S * 0.5, S * 0.46, S * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Gun barrel.
  ctx.fillStyle = dark;
  roundedRect(ctx, S * 0.62, S * 0.43, S * 0.28, S * 0.06, 2);
  ctx.fill();
}

function paintArtillery(ctx: Ctx, body: string, dark: string, light: string): void {
  const S = SPRITE_SIZE;
  // Lower carriage.
  ctx.fillStyle = dark;
  roundedRect(ctx, S * 0.18, S * 0.62, S * 0.5, S * 0.18, 3);
  ctx.fill();
  // Wheels (two prominent).
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(S * 0.28, S * 0.78, S * 0.10, 0, Math.PI * 2);
  ctx.arc(S * 0.58, S * 0.78, S * 0.10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Body / breech.
  ctx.fillStyle = body;
  roundedRect(ctx, S * 0.22, S * 0.5, S * 0.4, S * 0.18, 3);
  ctx.fill();
  // Long barrel — diagonal upward.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(S * 0.42, S * 0.56);
  ctx.lineTo(S * 0.86, S * 0.30);
  ctx.stroke();
  // Barrel highlight.
  ctx.strokeStyle = light;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(S * 0.42, S * 0.54);
  ctx.lineTo(S * 0.86, S * 0.28);
  ctx.stroke();
}

function paintCopter(ctx: Ctx, body: string, dark: string, _light: string, detail: string): void {
  const S = SPRITE_SIZE;
  // Body.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(S * 0.5, S * 0.6, S * 0.22, S * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  // Tail boom.
  ctx.fillStyle = body;
  roundedRect(ctx, S * 0.66, S * 0.58, S * 0.22, S * 0.06, 2);
  ctx.fill();
  // Tail rotor.
  ctx.fillStyle = dark;
  ctx.fillRect(S * 0.86, S * 0.5, S * 0.04, S * 0.18);
  // Cockpit glass.
  ctx.fillStyle = detail;
  ctx.beginPath();
  ctx.ellipse(S * 0.4, S * 0.56, S * 0.07, S * 0.05, 0, 0, Math.PI * 2);
  ctx.fill();
  // Landing skids.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(S * 0.32, S * 0.78);
  ctx.lineTo(S * 0.66, S * 0.78);
  ctx.stroke();
  // Skid struts.
  ctx.beginPath();
  ctx.moveTo(S * 0.38, S * 0.72);
  ctx.lineTo(S * 0.4, S * 0.78);
  ctx.moveTo(S * 0.58, S * 0.72);
  ctx.lineTo(S * 0.6, S * 0.78);
  ctx.stroke();
  // Rotor blade (top) — drawn as a long thin horizontal element.
  ctx.fillStyle = dark;
  ctx.fillRect(S * 0.16, S * 0.32, S * 0.68, S * 0.04);
  // Rotor hub.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(S * 0.5, S * 0.34, S * 0.04, 0, Math.PI * 2);
  ctx.fill();
}

function paintTransport(ctx: Ctx, body: string, dark: string, light: string): void {
  const S = SPRITE_SIZE;
  // Water hint: faint waves below the hull.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(S * 0.18, S * 0.82);
  ctx.quadraticCurveTo(S * 0.3, S * 0.78, S * 0.42, S * 0.82);
  ctx.quadraticCurveTo(S * 0.54, S * 0.86, S * 0.66, S * 0.82);
  ctx.quadraticCurveTo(S * 0.78, S * 0.78, S * 0.82, S * 0.82);
  ctx.stroke();
  // Hull: trapezoid pointing right.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(S * 0.16, S * 0.6);
  ctx.lineTo(S * 0.78, S * 0.6);
  ctx.lineTo(S * 0.86, S * 0.74);
  ctx.lineTo(S * 0.22, S * 0.74);
  ctx.closePath();
  ctx.fill();
  // Deckline.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(S * 0.16, S * 0.6);
  ctx.lineTo(S * 0.78, S * 0.6);
  ctx.stroke();
  // Cabin block.
  ctx.fillStyle = light;
  roundedRect(ctx, S * 0.34, S * 0.4, S * 0.26, S * 0.18, 3);
  ctx.fill();
  // Cabin window strip.
  ctx.fillStyle = dark;
  ctx.fillRect(S * 0.38, S * 0.46, S * 0.18, S * 0.04);
  // Stack.
  ctx.fillStyle = dark;
  roundedRect(ctx, S * 0.6, S * 0.34, S * 0.08, S * 0.18, 1);
  ctx.fill();
  // Bow flag mast.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(S * 0.22, S * 0.6);
  ctx.lineTo(S * 0.22, S * 0.42);
  ctx.stroke();
  // Flag.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(S * 0.22, S * 0.42);
  ctx.lineTo(S * 0.3, S * 0.46);
  ctx.lineTo(S * 0.22, S * 0.5);
  ctx.closePath();
  ctx.fill();
}

function paintFighter(ctx: Ctx, body: string, dark: string, light: string, detail: string): void {
  const S = SPRITE_SIZE;
  // Swept-wing fighter pointing right. Wings angled back from a central fuselage.
  ctx.fillStyle = body;
  ctx.beginPath();
  // Nose at (0.88, 0.5); wing tips swept back.
  ctx.moveTo(S * 0.88, S * 0.5);
  ctx.lineTo(S * 0.46, S * 0.42);
  ctx.lineTo(S * 0.18, S * 0.28);
  ctx.lineTo(S * 0.28, S * 0.5);
  ctx.lineTo(S * 0.18, S * 0.72);
  ctx.lineTo(S * 0.46, S * 0.58);
  ctx.closePath();
  ctx.fill();
  // Fuselage centerline highlight.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(S * 0.30, S * 0.5);
  ctx.lineTo(S * 0.86, S * 0.5);
  ctx.stroke();
  // Cockpit canopy near the nose.
  ctx.fillStyle = detail;
  ctx.beginPath();
  ctx.ellipse(S * 0.66, S * 0.48, S * 0.06, S * 0.04, 0, 0, Math.PI * 2);
  ctx.fill();
  // Tail fin.
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.moveTo(S * 0.30, S * 0.5);
  ctx.lineTo(S * 0.24, S * 0.36);
  ctx.lineTo(S * 0.34, S * 0.46);
  ctx.closePath();
  ctx.fill();
}

function paintBomber(ctx: Ctx, body: string, dark: string, _light: string, detail: string): void {
  const S = SPRITE_SIZE;
  // Long fuselage pointing right with broader straight wings.
  ctx.fillStyle = body;
  // Body — elongated triangle.
  ctx.beginPath();
  ctx.moveTo(S * 0.92, S * 0.5);
  ctx.lineTo(S * 0.16, S * 0.4);
  ctx.lineTo(S * 0.16, S * 0.6);
  ctx.closePath();
  ctx.fill();
  // Wings — broad straight cross section.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(S * 0.42, S * 0.5);
  ctx.lineTo(S * 0.50, S * 0.18);
  ctx.lineTo(S * 0.58, S * 0.22);
  ctx.lineTo(S * 0.54, S * 0.5);
  ctx.lineTo(S * 0.58, S * 0.78);
  ctx.lineTo(S * 0.50, S * 0.82);
  ctx.closePath();
  ctx.fill();
  // Two engine dots on the wings.
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.arc(S * 0.52, S * 0.28, S * 0.045, 0, Math.PI * 2);
  ctx.arc(S * 0.52, S * 0.72, S * 0.045, 0, Math.PI * 2);
  ctx.fill();
  // Engine inner highlights.
  ctx.fillStyle = detail;
  ctx.beginPath();
  ctx.arc(S * 0.52, S * 0.28, S * 0.02, 0, Math.PI * 2);
  ctx.arc(S * 0.52, S * 0.72, S * 0.02, 0, Math.PI * 2);
  ctx.fill();
  // Cockpit at the nose.
  ctx.fillStyle = detail;
  ctx.beginPath();
  ctx.ellipse(S * 0.78, S * 0.5, S * 0.05, S * 0.035, 0, 0, Math.PI * 2);
  ctx.fill();
  // Tail.
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.moveTo(S * 0.20, S * 0.5);
  ctx.lineTo(S * 0.14, S * 0.34);
  ctx.lineTo(S * 0.24, S * 0.46);
  ctx.closePath();
  ctx.fill();
}

function paintBattleship(ctx: Ctx, body: string, dark: string, light: string): void {
  const S = SPRITE_SIZE;
  // Water waves below.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(S * 0.08, S * 0.84);
  ctx.quadraticCurveTo(S * 0.22, S * 0.80, S * 0.36, S * 0.84);
  ctx.quadraticCurveTo(S * 0.50, S * 0.88, S * 0.64, S * 0.84);
  ctx.quadraticCurveTo(S * 0.78, S * 0.80, S * 0.92, S * 0.84);
  ctx.stroke();
  // Long ship hull — pointier prow than the transport.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(S * 0.06, S * 0.62);
  ctx.lineTo(S * 0.82, S * 0.58);
  ctx.lineTo(S * 0.94, S * 0.66);
  ctx.lineTo(S * 0.82, S * 0.78);
  ctx.lineTo(S * 0.12, S * 0.78);
  ctx.closePath();
  ctx.fill();
  // Deck line.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(S * 0.06, S * 0.62);
  ctx.lineTo(S * 0.82, S * 0.58);
  ctx.stroke();
  // Three turret blocks along the deck.
  ctx.fillStyle = dark;
  roundedRect(ctx, S * 0.16, S * 0.48, S * 0.14, S * 0.12, 2);
  ctx.fill();
  roundedRect(ctx, S * 0.40, S * 0.46, S * 0.14, S * 0.12, 2);
  ctx.fill();
  roundedRect(ctx, S * 0.64, S * 0.48, S * 0.14, S * 0.12, 2);
  ctx.fill();
  // Long gun barrels poking forward from each turret.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(S * 0.28, S * 0.54);
  ctx.lineTo(S * 0.40, S * 0.50);
  ctx.moveTo(S * 0.52, S * 0.52);
  ctx.lineTo(S * 0.64, S * 0.48);
  ctx.moveTo(S * 0.76, S * 0.54);
  ctx.lineTo(S * 0.88, S * 0.50);
  ctx.stroke();
  // Central bridge tower.
  ctx.fillStyle = light;
  roundedRect(ctx, S * 0.46, S * 0.32, S * 0.10, S * 0.18, 2);
  ctx.fill();
  // Smokestack.
  ctx.fillStyle = dark;
  roundedRect(ctx, S * 0.58, S * 0.36, S * 0.05, S * 0.18, 1);
  ctx.fill();
}

function paintCruiser(ctx: Ctx, body: string, dark: string, light: string): void {
  const S = SPRITE_SIZE;
  // Waves.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(S * 0.16, S * 0.84);
  ctx.quadraticCurveTo(S * 0.30, S * 0.80, S * 0.44, S * 0.84);
  ctx.quadraticCurveTo(S * 0.58, S * 0.88, S * 0.72, S * 0.84);
  ctx.quadraticCurveTo(S * 0.82, S * 0.82, S * 0.86, S * 0.84);
  ctx.stroke();
  // Shorter hull.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(S * 0.14, S * 0.62);
  ctx.lineTo(S * 0.74, S * 0.6);
  ctx.lineTo(S * 0.86, S * 0.7);
  ctx.lineTo(S * 0.74, S * 0.78);
  ctx.lineTo(S * 0.20, S * 0.78);
  ctx.closePath();
  ctx.fill();
  // Deck line.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(S * 0.14, S * 0.62);
  ctx.lineTo(S * 0.74, S * 0.6);
  ctx.stroke();
  // Single forward turret.
  ctx.fillStyle = dark;
  roundedRect(ctx, S * 0.48, S * 0.48, S * 0.14, S * 0.12, 2);
  ctx.fill();
  // Turret barrel.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(S * 0.60, S * 0.54);
  ctx.lineTo(S * 0.78, S * 0.50);
  ctx.stroke();
  // Bridge.
  ctx.fillStyle = light;
  roundedRect(ctx, S * 0.30, S * 0.40, S * 0.14, S * 0.20, 2);
  ctx.fill();
  // Tall radar mast.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(S * 0.37, S * 0.40);
  ctx.lineTo(S * 0.37, S * 0.16);
  ctx.stroke();
  // Mast cross bars.
  ctx.beginPath();
  ctx.moveTo(S * 0.32, S * 0.24);
  ctx.lineTo(S * 0.42, S * 0.24);
  ctx.moveTo(S * 0.34, S * 0.20);
  ctx.lineTo(S * 0.40, S * 0.20);
  ctx.stroke();
}

function paintAATank(ctx: Ctx, body: string, dark: string, light: string): void {
  const S = SPRITE_SIZE;
  // Tracks (dark slabs).
  ctx.fillStyle = dark;
  roundedRect(ctx, S * 0.14, S * 0.66, S * 0.72, S * 0.16, 3);
  ctx.fill();
  // Track ticks.
  ctx.strokeStyle = light;
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    const tx = S * 0.18 + i * S * 0.12;
    ctx.beginPath();
    ctx.moveTo(tx, S * 0.7);
    ctx.lineTo(tx, S * 0.78);
    ctx.stroke();
  }
  // Hull.
  ctx.fillStyle = body;
  roundedRect(ctx, S * 0.18, S * 0.5, S * 0.64, S * 0.2, 4);
  ctx.fill();
  // Compact AA turret (squarer than tank turret).
  ctx.fillStyle = body;
  roundedRect(ctx, S * 0.36, S * 0.34, S * 0.28, S * 0.18, 3);
  ctx.fill();
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Twin barrels pointing up — angled slightly outward.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(S * 0.44, S * 0.36);
  ctx.lineTo(S * 0.40, S * 0.10);
  ctx.moveTo(S * 0.56, S * 0.36);
  ctx.lineTo(S * 0.60, S * 0.10);
  ctx.stroke();
  // Barrel tips (muzzle highlight).
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.arc(S * 0.40, S * 0.10, S * 0.02, 0, Math.PI * 2);
  ctx.arc(S * 0.60, S * 0.10, S * 0.02, 0, Math.PI * 2);
  ctx.fill();
}

function paintLander(ctx: Ctx, body: string, dark: string, light: string): void {
  const S = SPRITE_SIZE;
  // Waves.
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(S * 0.10, S * 0.84);
  ctx.quadraticCurveTo(S * 0.24, S * 0.80, S * 0.38, S * 0.84);
  ctx.quadraticCurveTo(S * 0.52, S * 0.88, S * 0.66, S * 0.84);
  ctx.quadraticCurveTo(S * 0.80, S * 0.80, S * 0.90, S * 0.84);
  ctx.stroke();
  // Flat-bottomed boat — wide, low, square open deck.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(S * 0.12, S * 0.56);
  ctx.lineTo(S * 0.88, S * 0.56);
  ctx.lineTo(S * 0.84, S * 0.78);
  ctx.lineTo(S * 0.16, S * 0.78);
  ctx.closePath();
  ctx.fill();
  // Deck line.
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(S * 0.12, S * 0.56);
  ctx.lineTo(S * 0.88, S * 0.56);
  ctx.stroke();
  // Open deck cavity (suggests cargo bay).
  ctx.fillStyle = dark;
  roundedRect(ctx, S * 0.22, S * 0.58, S * 0.50, S * 0.14, 2);
  ctx.fill();
  // Inner deck floor.
  ctx.fillStyle = light;
  roundedRect(ctx, S * 0.26, S * 0.60, S * 0.42, S * 0.06, 1);
  ctx.fill();
  // Bow ramp (front end raised slightly).
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.moveTo(S * 0.72, S * 0.56);
  ctx.lineTo(S * 0.84, S * 0.50);
  ctx.lineTo(S * 0.88, S * 0.56);
  ctx.closePath();
  ctx.fill();
  // Small wheelhouse at the stern (left).
  ctx.fillStyle = body;
  roundedRect(ctx, S * 0.14, S * 0.44, S * 0.10, S * 0.14, 2);
  ctx.fill();
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(S * 0.16, S * 0.50);
  ctx.lineTo(S * 0.22, S * 0.50);
  ctx.stroke();
}

function paintDents(ctx: Ctx): void {
  const S = SPRITE_SIZE;
  ctx.save();
  ctx.strokeStyle = 'rgba(20,10,4,0.65)';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  // Two diagonal scratches.
  ctx.beginPath();
  ctx.moveTo(S * 0.32, S * 0.48);
  ctx.lineTo(S * 0.46, S * 0.6);
  ctx.moveTo(S * 0.58, S * 0.5);
  ctx.lineTo(S * 0.72, S * 0.62);
  ctx.stroke();
  // Tiny soot smudge.
  ctx.fillStyle = 'rgba(20,10,4,0.4)';
  ctx.beginPath();
  ctx.arc(S * 0.66, S * 0.46, S * 0.04, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ─────────────────────────── Drawing helpers ─────────────────────────────────

function roundedRect(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function parseHex(s: string): [number, number, number] {
  // Accept '#rrggbb'. Default to mid-grey if malformed.
  if (s.length === 7 && s[0] === '#') {
    const r = parseInt(s.slice(1, 3), 16);
    const g = parseInt(s.slice(3, 5), 16);
    const b = parseInt(s.slice(5, 7), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return [r, g, b];
    }
  }
  return [128, 128, 128];
}

function toHex([r, g, b]: [number, number, number]): string {
  const cl = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${cl(r)}${cl(g)}${cl(b)}`;
}

function darken(hex: string, k: number): string {
  const [r, g, b] = parseHex(hex);
  return toHex([r * (1 - k), g * (1 - k), b * (1 - k)]);
}

function lighten(hex: string, k: number): string {
  const [r, g, b] = parseHex(hex);
  return toHex([r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k]);
}
