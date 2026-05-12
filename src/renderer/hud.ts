// HUD: top bar (turn + current player + funds), end-turn button, action menu,
// build menu. All drawn on the same Canvas as the map. No DOM elements.
//
// Hit testing is exposed through helper functions so input.ts can map mouse
// clicks back to HUD interactions without re-implementing layout.

import type { GameState, PlayerId, UnitType } from '../engine/core/types';
import { UNITS } from '../engine/data';
import {
  HUD_HEIGHT,
  PLAYER_COLOURS,
} from './canvas';
import type {
  ActionMenuEntry,
  BuildMenuEntry,
  CanvasRenderer,
  Overlay,
} from './canvas';

const UNIT_LETTER: Record<UnitType, string> = {
  infantry: 'I',
  recon: 'R',
  tank: 'T',
  artillery: 'A',
  copter: 'C',
};

const BUILDABLE: ReadonlyArray<UnitType> = [
  'infantry',
  'recon',
  'tank',
  'artillery',
  'copter',
];

export type HudHitTarget =
  | { kind: 'end-turn' }
  | { kind: 'action-menu'; entry: ActionMenuEntry }
  | { kind: 'build-menu'; entry: BuildMenuEntry };

export type Hud = {
  draw(state: GameState, overlay: Overlay): void;
  /** Hit test in CSS pixels. Returns the topmost HUD target under (x,y). */
  hit(x: number, y: number, state: GameState, overlay: Overlay): HudHitTarget | null;
};

export function createHud(renderer: CanvasRenderer): Hud {
  function draw(state: GameState, overlay: Overlay): void {
    const ctx = renderer.canvas.getContext('2d');
    if (!ctx) return;
    drawTopBar(ctx, renderer, state);
    drawEndTurnButton(ctx, renderer, state);
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
    // End-turn button.
    const r = renderer.getEndTurnRect();
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      return { kind: 'end-turn' };
    }
    return null;
  }

  return { draw, hit };
}

// ─────────────────────────── Top bar ─────────────────────────────────────────

function drawTopBar(
  ctx: CanvasRenderingContext2D,
  renderer: CanvasRenderer,
  state: GameState,
): void {
  const vp = renderer.getViewport();
  ctx.fillStyle = '#121418';
  ctx.fillRect(0, 0, vp.width, HUD_HEIGHT);
  ctx.fillStyle = '#222630';
  ctx.fillRect(0, HUD_HEIGHT - 2, vp.width, 2);

  const player = state.currentPlayer;
  const palette = PLAYER_COLOURS[player];
  // Player swatch.
  ctx.fillStyle = palette.fill;
  ctx.fillRect(16, 14, 28, 28);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.strokeRect(16.5, 14.5, 27, 27);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Player ${player + 1}`, 52, 28);

  ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillStyle = '#a8b0c0';
  ctx.fillText(`Turn ${state.turn}`, 52, 46);

  // Funds.
  ctx.fillStyle = '#ffd84a';
  ctx.font = 'bold 16px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText(
    `$${state.players[player].funds.toLocaleString('en-US')}`,
    160,
    28,
  );
  const other: PlayerId = player === 0 ? 1 : 0;
  ctx.fillStyle = '#7a8090';
  ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText(
    `opp $${state.players[other].funds.toLocaleString('en-US')}`,
    160,
    46,
  );
}

// ─────────────────────────── End-turn button ─────────────────────────────────

function drawEndTurnButton(
  ctx: CanvasRenderingContext2D,
  renderer: CanvasRenderer,
  state: GameState,
): void {
  const r = renderer.getEndTurnRect();
  const disabled = state.winner !== null;
  ctx.fillStyle = disabled ? '#2a2a2a' : '#3a8a40';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = disabled ? '#3a3a3a' : '#7ec97e';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5);
  ctx.fillStyle = disabled ? '#666' : '#fff';
  ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('End Turn ⏎', r.x + r.w / 2, r.y + r.h / 2 + 1);
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
  if (y < HUD_HEIGHT + 4) y = HUD_HEIGHT + 4;
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

export function buildMenuEntries(state: GameState, owner: PlayerId): BuildMenuEntry[] {
  const funds = state.players[owner].funds;
  const entries: BuildMenuEntry[] = [];
  for (const type of BUILDABLE) {
    const cost = UNITS[type].cost;
    entries.push({
      unitType: type,
      label: capitalise(type),
      cost,
      affordable: funds >= cost,
    });
  }
  return entries;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
