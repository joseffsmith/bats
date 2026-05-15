// Canvas HUD: tile-anchored popovers only (action menu, build menu).
//
// The persistent chrome — top player HUDs, turn indicator, end-turn button,
// toolshelf — is rendered as DOM in chrome.ts. Anything that needs to anchor
// to a specific tile coordinate stays on canvas so it scrolls with the board.
//
// Hit testing is exposed through helper functions so input.ts can map mouse
// clicks back to HUD interactions without re-implementing layout.

import type { GameState, PlayerId, UnitType } from '../engine/core/types';
import { UNITS } from '../engine/data';
import { BOARD_TOP_INSET } from './canvas';
import type {
  ActionMenuEntry,
  BuildMenuEntry,
  CanvasRenderer,
  Overlay,
} from './canvas';

// Build-menu icon letters. Each unit type gets a unique letter; the existing
// 6 keep their letters, the new 6 take F/B/S/U/K/L (chosen to avoid clashes
// with recon=R, artillery=A and transport=X). See README/PLAN for the full
// mapping. The renderer's tile-letter fallback in canvas.ts uses the same
// table.
const UNIT_LETTER: Record<UnitType, string> = {
  infantry: 'I',
  recon: 'R',
  tank: 'T',
  artillery: 'A',
  copter: 'C',
  transport: 'X',
  fighter: 'F',
  bomber: 'B',
  battleship: 'S',
  cruiser: 'U',
  aatank: 'K',
  lander: 'L',
};

// Sea-class units (transport, battleship, cruiser, lander) can only launch
// from a factory adjacent to a sea tile — otherwise they'd spawn stranded on
// land they can't traverse. The validator at checkBuild enforces this; the
// build menu filters them out so the option isn't even offered.
const BUILDABLE: ReadonlyArray<UnitType> = [
  'infantry',
  'recon',
  'tank',
  'artillery',
  'aatank',
  'copter',
  'fighter',
  'bomber',
  'transport',
  'lander',
  'cruiser',
  'battleship',
];

function isCoastalFactory(state: GameState, at: { x: number; y: number }): boolean {
  const neighbours = [
    { x: at.x - 1, y: at.y },
    { x: at.x + 1, y: at.y },
    { x: at.x, y: at.y - 1 },
    { x: at.x, y: at.y + 1 },
  ];
  for (const n of neighbours) {
    const row = state.map[n.y];
    if (!row) continue;
    const tile = row[n.x];
    if (tile && tile.terrain === 'sea') return true;
  }
  return false;
}

export type HudHitTarget =
  | { kind: 'action-menu'; entry: ActionMenuEntry }
  | { kind: 'build-menu'; entry: BuildMenuEntry };

export type Hud = {
  draw(state: GameState, overlay: Overlay): void;
  /** Hit test in CSS pixels. Returns the topmost HUD target under (x,y). */
  hit(x: number, y: number, state: GameState, overlay: Overlay): HudHitTarget | null;
};

export function createHud(renderer: CanvasRenderer): Hud {
  function draw(_state: GameState, overlay: Overlay): void {
    const ctx = renderer.canvas.getContext('2d');
    if (!ctx) return;
    if (overlay.actionMenu) drawActionMenu(ctx, renderer, overlay.actionMenu);
    if (overlay.buildMenu) drawBuildMenu(ctx, renderer, overlay.buildMenu);
  }

  function hit(
    x: number,
    y: number,
    state: GameState,
    overlay: Overlay,
  ): HudHitTarget | null {
    if (state.winner !== null) return null;
    // Build menu has highest priority.
    if (overlay.buildMenu) {
      const layout = buildMenuLayout(renderer, overlay.buildMenu);
      for (const item of layout.items) {
        if (x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + item.h) {
          return { kind: 'build-menu', entry: item.entry };
        }
      }
    }
    // Action menu next.
    if (overlay.actionMenu) {
      const layout = actionMenuLayout(renderer, overlay.actionMenu);
      for (const item of layout.items) {
        if (x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + item.h) {
          return { kind: 'action-menu', entry: item.entry };
        }
      }
    }
    return null;
  }

  return { draw, hit };
}

// ─────────────────────────── Action menu ─────────────────────────────────────

type ActionMenuLayout = {
  items: Array<{
    entry: ActionMenuEntry;
    x: number;
    y: number;
    w: number;
    h: number;
  }>;
  rect: { x: number; y: number; w: number; h: number };
};

function actionMenuLayout(
  renderer: CanvasRenderer,
  menu: NonNullable<Overlay['actionMenu']>,
): ActionMenuLayout {
  const vp = renderer.getViewport();
  const tilePos = renderer.tileToPixel(menu.tile);
  const itemH = 30;
  const w = 120;
  const h = menu.entries.length * itemH + 8;
  let x = tilePos.x + vp.tileSize + 8;
  let y = tilePos.y;
  if (x + w > vp.width - 8) x = tilePos.x - w - 8;
  if (y + h > vp.height - 8) y = vp.height - h - 8;
  const items = menu.entries.map((entry, i) => ({
    entry,
    x: x + 4,
    y: y + 4 + i * itemH,
    w: w - 8,
    h: itemH - 2,
  }));
  return { items, rect: { x, y, w, h } };
}

function drawActionMenu(
  ctx: CanvasRenderingContext2D,
  renderer: CanvasRenderer,
  menu: NonNullable<Overlay['actionMenu']>,
): void {
  const layout = actionMenuLayout(renderer, menu);
  const r = layout.rect;
  ctx.fillStyle = 'rgba(20,20,24,0.95)';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = '#ffd84a';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5);
  for (const item of layout.items) {
    ctx.fillStyle = item.entry.enabled ? '#222831' : '#1a1a1a';
    ctx.fillRect(item.x, item.y, item.w, item.h);
    ctx.fillStyle = item.entry.enabled ? '#fff' : '#666';
    ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.entry.label, item.x + 8, item.y + item.h / 2 + 1);
  }
}

// ─────────────────────────── Build menu ──────────────────────────────────────

type BuildMenuLayout = {
  items: Array<{
    entry: BuildMenuEntry;
    x: number;
    y: number;
    w: number;
    h: number;
  }>;
  rect: { x: number; y: number; w: number; h: number };
};

function buildMenuLayout(
  renderer: CanvasRenderer,
  menu: NonNullable<Overlay['buildMenu']>,
): BuildMenuLayout {
  const vp = renderer.getViewport();
  const tilePos = renderer.tileToPixel(menu.tile);
  const itemH = 36;
  const w = 200;
  const h = menu.entries.length * itemH + 8;
  let x = tilePos.x + vp.tileSize + 8;
  let y = tilePos.y;
  if (x + w > vp.width - 8) x = tilePos.x - w - 8;
  if (y + h > vp.height - 8) y = vp.height - h - 8;
  if (y < BOARD_TOP_INSET + 4) y = BOARD_TOP_INSET + 4;
  const items = menu.entries.map((entry, i) => ({
    entry,
    x: x + 4,
    y: y + 4 + i * itemH,
    w: w - 8,
    h: itemH - 2,
  }));
  return { items, rect: { x, y, w, h } };
}

function drawBuildMenu(
  ctx: CanvasRenderingContext2D,
  renderer: CanvasRenderer,
  menu: NonNullable<Overlay['buildMenu']>,
): void {
  const layout = buildMenuLayout(renderer, menu);
  const r = layout.rect;
  ctx.fillStyle = 'rgba(16,16,20,0.96)';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = '#ffd84a';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5);
  for (const item of layout.items) {
    ctx.fillStyle = item.entry.affordable ? '#222831' : '#181818';
    ctx.fillRect(item.x, item.y, item.w, item.h);

    // Player-coloured square icon with unit letter.
    const iconSize = 26;
    const iconX = item.x + 4;
    const iconY = item.y + (item.h - iconSize) / 2;
    ctx.fillStyle = item.entry.affordable ? '#444' : '#2a2a2a';
    ctx.fillRect(iconX, iconY, iconSize, iconSize);
    ctx.fillStyle = item.entry.affordable ? '#fff' : '#666';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(UNIT_LETTER[item.entry.unitType], iconX + iconSize / 2, iconY + iconSize / 2 + 1);

    ctx.fillStyle = item.entry.affordable ? '#fff' : '#666';
    ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.entry.label, iconX + iconSize + 8, item.y + item.h / 2 - 6);
    ctx.fillStyle = item.entry.affordable ? '#ffd84a' : '#5a5a3a';
    ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(
      `$${item.entry.cost.toLocaleString('en-US')}`,
      iconX + iconSize + 8,
      item.y + item.h / 2 + 8,
    );
  }
}

// ─────────────────────────── Build menu factory ──────────────────────────────

export function buildMenuEntries(
  state: GameState,
  owner: PlayerId,
  at: { x: number; y: number },
): BuildMenuEntry[] {
  const funds = state.players[owner].funds;
  const coastal = isCoastalFactory(state, at);
  const entries: BuildMenuEntry[] = [];
  for (const type of BUILDABLE) {
    // Sea-class units (transport, lander, cruiser, battleship) need a sea
    // tile adjacent to the factory to launch. The engine's BUILD validator
    // also enforces this — filtering here just keeps the menu honest.
    if (UNITS[type].movementClass === 'sea' && !coastal) continue;
    const cost = UNITS[type].cost;
    entries.push({
      unitType: type,
      label: labelFor(type),
      cost,
      affordable: funds >= cost,
    });
  }
  return entries;
}

function labelFor(type: UnitType): string {
  // `aatank` reads better as "AA Tank" in the build menu UI.
  if (type === 'aatank') return 'AA Tank';
  return capitalise(type);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
