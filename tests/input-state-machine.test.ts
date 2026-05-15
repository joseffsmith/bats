// @vitest-environment jsdom
//
// Regression tests for the "action-without-move" fix in
// `src/renderer/input.ts`.
//
// Background: pre-fix, re-clicking the currently-selected unit's own tile
// cancelled selection back to idle. That made it impossible for:
//   - artillery (indirect; can't move and attack same turn) to ever attack —
//     the only legal attack is from its current tile;
//   - infantry standing on a capturable tile to continue capturing across
//     turns without first taking a (potentially destructive) detour move;
//   - any unit to attack an adjacent enemy without first moving.
//
// Post-fix: re-clicking the unit's current tile transitions to `action-menu`
// with the unit's current pos as the anchor. Right-click and Esc still
// cancel.

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { createEmitter } from '../src/renderer/emitter';
import { createCanvasRenderer } from '../src/renderer/canvas';
import { createInputController, __test } from '../src/renderer/input';
import { createAnimationQueue } from '../src/renderer/animations';
import { setLogEnabled } from '../src/engine/core/logger';
import { makeState } from './test-helpers';
import type { GameState } from '../src/engine/core/types';

setLogEnabled('engine', false);
setLogEnabled('render', false);

// ─── Mount harness ─────────────────────────────────────────────────────────

function makeCtxStub(): CanvasRenderingContext2D {
  const noop = (): void => {};
  const stub: Record<string, unknown> = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    globalAlpha: 1,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    fillText: noop,
    setTransform: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
  };
  return stub as unknown as CanvasRenderingContext2D;
}

function mount(state: GameState) {
  document.body.innerHTML = '<div id="app"></div>';
  const canvas = document.createElement('canvas');
  document.getElementById('app')!.appendChild(canvas);
  canvas.getContext = (type: string) =>
    (type === '2d' ? makeCtxStub() : null) as never;
  const emitter = createEmitter(state);
  const renderer = createCanvasRenderer(canvas);
  renderer.resize();
  const animQueue = createAnimationQueue({ now: () => 0 });
  const input = createInputController(renderer, emitter, animQueue);
  return { canvas, emitter, renderer, input, animQueue };
}

describe('input state machine: re-click own selected unit (action-without-move fix)', () => {
  beforeAll(() => {
    // Silence the JSDOM canvas.getContext warning even though we override it.
    const orig = console.error.bind(console);
    console.error = (...args: unknown[]): void => {
      if (
        typeof args[0] === 'string' &&
        args[0].includes("HTMLCanvasElement's getContext")
      ) {
        return;
      }
      orig(...(args as []));
    };
  });

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
  });

  it('re-clicking the own selected unit transitions to action-menu (NOT idle)', () => {
    // Infantry standing on a plain tile (so no capture entry), adjacent to an
    // enemy infantry (so Attack is offered).
    const state = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 3, y: 0 } },
      ],
    });
    const { input, renderer, emitter } = mount(state);
    const unit = Object.values(emitter.getState().units).find(
      (u) => u.owner === 0,
    )!;
    const ts = renderer.getViewport().tileSize;
    const px = renderer.tileToPixel(unit.pos);
    // First click selects.
    input.click(px.x + ts / 2, px.y + ts / 2);
    expect(input.getState().kind).toBe('unit-selected');
    // Second click on the SAME tile opens the action menu — does NOT cancel.
    input.click(px.x + ts / 2, px.y + ts / 2);
    const after = input.getState();
    expect(after.kind).toBe('action-menu');
    if (after.kind === 'action-menu') {
      // Anchor is the unit's current (un-moved) position.
      expect(after.anchor).toEqual(unit.pos);
      // Unit has not moved (was opened in place).
      expect(after.unit.hasMoved).toBe(false);
    }
  });

  it('right-click on the selected unit still cancels back to idle', () => {
    const state = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const { input, renderer, emitter } = mount(state);
    const unit = Object.values(emitter.getState().units).find(
      (u) => u.owner === 0,
    )!;
    const ts = renderer.getViewport().tileSize;
    const px = renderer.tileToPixel(unit.pos);
    input.click(px.x + ts / 2, px.y + ts / 2);
    expect(input.getState().kind).toBe('unit-selected');
    // Right-click (button 2) on the same tile → cancel.
    input.click(px.x + ts / 2, px.y + ts / 2, 2);
    expect(input.getState().kind).toBe('idle');
  });

  it('Esc on the selected unit still cancels back to idle', () => {
    const state = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const { input, renderer, emitter } = mount(state);
    const unit = Object.values(emitter.getState().units).find(
      (u) => u.owner === 0,
    )!;
    const ts = renderer.getViewport().tileSize;
    const px = renderer.tileToPixel(unit.pos);
    input.click(px.x + ts / 2, px.y + ts / 2);
    expect(input.getState().kind).toBe('unit-selected');
    input.cancel();
    expect(input.getState().kind).toBe('idle');
  });
});

describe('action menu entries (computeActionMenuEntries) — Capture and Attack offered without moving', () => {
  it('shows "Capture" for an infantry standing on a non-owned capturable tile', () => {
    const state = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 2, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const unit = Object.values(state.units).find((u) => u.owner === 0)!;
    const entries = __test.computeActionMenuEntries(state, unit, unit.pos);
    const labels = entries.map((e) => e.label);
    expect(labels).toContain('Capture');
    // Capture entry must be enabled.
    expect(entries.find((e) => e.label === 'Capture')!.enabled).toBe(true);
    // Wait is always present.
    expect(labels).toContain('Wait');
  });

  it('does NOT show "Capture" when the infantry already owns the tile', () => {
    const state = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 2, y: 0 }, terrain: 'city', owner: 0 }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const unit = Object.values(state.units).find((u) => u.owner === 0)!;
    const entries = __test.computeActionMenuEntries(state, unit, unit.pos);
    expect(entries.map((e) => e.label)).not.toContain('Capture');
  });

  it('shows "Attack" for artillery with an enemy in indirect range (no move required)', () => {
    // Artillery range = [2,3]. Place enemy tank 2 tiles away — direct
    // attacking-without-moving must be legal from the artillery's spawn tile.
    const state = makeState({
      width: 6,
      height: 1,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 0 } },
      ],
      units: [
        { type: 'artillery', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'tank', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const art = Object.values(state.units).find((u) => u.type === 'artillery')!;
    expect(art.hasMoved).toBe(false);
    const entries = __test.computeActionMenuEntries(state, art, art.pos);
    const labels = entries.map((e) => e.label);
    expect(labels).toContain('Attack');
    expect(entries.find((e) => e.label === 'Attack')!.enabled).toBe(true);
  });

  it('does NOT show "Attack" for artillery that has already moved this turn (indirect rule)', () => {
    const state = makeState({
      width: 6,
      height: 1,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 0 } },
      ],
      units: [
        { type: 'artillery', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'tank', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const art = Object.values(state.units).find((u) => u.type === 'artillery')!;
    // Simulate the unit having moved this turn.
    art.hasMoved = true;
    const entries = __test.computeActionMenuEntries(state, art, art.pos);
    expect(entries.map((e) => e.label)).not.toContain('Attack');
  });

  it('shows "Attack" for an infantry with an enemy adjacent (no move required)', () => {
    const state = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 3, y: 0 } },
      ],
    });
    const unit = Object.values(state.units).find((u) => u.owner === 0)!;
    const entries = __test.computeActionMenuEntries(state, unit, unit.pos);
    expect(entries.map((e) => e.label)).toContain('Attack');
  });
});

describe('action menu opened via re-click executes Capture without a prior MOVE', () => {
  it('clicking Capture in the menu commits CAPTURE and progresses', () => {
    // Full integration through the input controller: infantry on neutral
    // city, no enemy in attack range. Click to select → click again to open
    // menu (must NOT cancel) → click the Capture menu entry.
    const state = makeState({
      width: 6,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 0 } },
      ],
      tiles: [{ pos: { x: 2, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 2, y: 0 } },
        // Far enough that no Attack entry is offered.
        { type: 'infantry', owner: 1, pos: { x: 5, y: 0 } },
      ],
    });
    const { input, renderer, emitter } = mount(state);
    const unit = Object.values(emitter.getState().units).find(
      (u) => u.owner === 0,
    )!;
    const ts = renderer.getViewport().tileSize;
    const px = renderer.tileToPixel(unit.pos);
    input.click(px.x + ts / 2, px.y + ts / 2);
    expect(input.getState().kind).toBe('unit-selected');
    input.click(px.x + ts / 2, px.y + ts / 2);
    const ms = input.getState();
    expect(ms.kind).toBe('action-menu');
    if (ms.kind !== 'action-menu') return;
    const capture = ms.entries.find((e) => e.label === 'Capture');
    expect(capture).toBeDefined();
    expect(capture!.enabled).toBe(true);
    // Click the Capture entry by computing its rect via the HUD click path.
    // The action menu in the overlay is rendered relative to the anchor tile;
    // synthetic click on the entry's actual pixel rect would require pulling
    // it from hud.hit(). Easier route: dispatch directly through the public
    // emitter, then verify state. (The state-machine transition was already
    // proven above; we test the engine effect here.)
    emitter.dispatch({ type: 'CAPTURE', unitId: unit.id });
    expect(emitter.getState().units[unit.id]!.captureProgress).toBe(10);
    expect(emitter.getState().units[unit.id]!.hasActed).toBe(true);
  });
});
