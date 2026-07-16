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

function mount(state: GameState, opts?: { coarsePointer?: boolean }) {
  document.body.innerHTML = '<div id="app"></div>';
  const canvas = document.createElement('canvas');
  document.getElementById('app')!.appendChild(canvas);
  canvas.getContext = (type: string) =>
    (type === '2d' ? makeCtxStub() : null) as never;
  const emitter = createEmitter(state);
  const renderer = createCanvasRenderer(canvas);
  renderer.resize();
  const animQueue = createAnimationQueue({ now: () => 0 });
  const input = createInputController(renderer, emitter, animQueue, opts);
  return { canvas, emitter, renderer, input, animQueue };
}

/** Click a tile's centre through the input controller. */
function clickTileCentre(
  input: ReturnType<typeof mount>['input'],
  renderer: ReturnType<typeof mount>['renderer'],
  tile: { x: number; y: number },
): void {
  const ts = renderer.getViewport().tileSize;
  const px = renderer.tileToPixel(tile);
  input.click(px.x + ts / 2, px.y + ts / 2);
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
    // The DOM menu button calls input.chooseAction directly (menus.ts) — drive
    // that path here rather than the old canvas hit-test.
    input.chooseAction('Capture');
    expect(emitter.getState().units[unit.id]!.captureProgress).toBe(10);
    expect(emitter.getState().units[unit.id]!.hasActed).toBe(true);
    // Committing CAPTURE returns the state machine to idle.
    expect(input.getState().kind).toBe('idle');
  });
});

describe('chooseAction / chooseBuild (DOM menu entry callbacks)', () => {
  it('chooseAction("Attack") transitions action-menu → attack-targeting', () => {
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
    const unit = Object.values(emitter.getState().units).find((u) => u.owner === 0)!;
    const ts = renderer.getViewport().tileSize;
    const px = renderer.tileToPixel(unit.pos);
    input.click(px.x + ts / 2, px.y + ts / 2); // select
    input.click(px.x + ts / 2, px.y + ts / 2); // open action menu in place
    expect(input.getState().kind).toBe('action-menu');
    input.chooseAction('Attack');
    const after = input.getState();
    expect(after.kind).toBe('attack-targeting');
    if (after.kind === 'attack-targeting') {
      expect(after.targets.some((t) => t.owner === 1)).toBe(true);
    }
  });

  it('chooseAction ignores a call when not in action-menu state', () => {
    const state = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [{ type: 'infantry', owner: 0, pos: { x: 2, y: 0 } }],
    });
    const { input } = mount(state);
    expect(input.getState().kind).toBe('idle');
    input.chooseAction('Wait'); // no-op — no menu open
    expect(input.getState().kind).toBe('idle');
  });

  it('chooseBuild commits a BUILD for an affordable entry and returns to idle', () => {
    const state = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 2, y: 0 }, terrain: 'factory', owner: 0 }],
      units: [],
    });
    // Ensure P0 can afford infantry.
    state.players[0].funds = 99999;
    const { input, renderer, emitter } = mount(state);
    const ts = renderer.getViewport().tileSize;
    const px = renderer.tileToPixel({ x: 2, y: 0 });
    input.click(px.x + ts / 2, px.y + ts / 2); // open build menu
    expect(input.getState().kind).toBe('build-menu-open');
    input.chooseBuild('infantry');
    expect(input.getState().kind).toBe('idle');
    const built = Object.values(emitter.getState().units).find(
      (u) => u.owner === 0 && u.pos.x === 2 && u.pos.y === 0,
    );
    expect(built?.type).toBe('infantry');
  });
});

describe('two-tap attack confirm on coarse (touch) pointers', () => {
  // Attacker at (2,0) with an enemy on each side — (1,0) and (3,0) — so both are
  // in melee range and the target picker has two options to switch between.
  function twoEnemyState(): GameState {
    return makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 3, y: 0 } },
      ],
    });
  }

  function intoAttackTargeting(coarse: boolean) {
    const state = twoEnemyState();
    const h = mount(state, { coarsePointer: coarse });
    clickTileCentre(h.input, h.renderer, { x: 2, y: 0 }); // select attacker
    clickTileCentre(h.input, h.renderer, { x: 2, y: 0 }); // open action menu in place
    expect(h.input.getState().kind).toBe('action-menu');
    h.input.chooseAction('Attack');
    expect(h.input.getState().kind).toBe('attack-targeting');
    return h;
  }

  it('first tap previews (hover set), second tap on the SAME enemy commits', () => {
    const h = intoAttackTargeting(true);
    const enemyBefore = Object.values(h.emitter.getState().units).find(
      (u) => u.owner === 1 && u.pos.x === 3,
    )!;

    // First tap: no ATTACK yet, still targeting, hover points at the enemy.
    clickTileCentre(h.input, h.renderer, { x: 3, y: 0 });
    const mid = h.input.getState();
    expect(mid.kind).toBe('attack-targeting');
    if (mid.kind === 'attack-targeting') {
      expect(mid.hover?.id).toBe(enemyBefore.id);
    }
    expect(h.emitter.getState().units[enemyBefore.id]!.hp).toBe(100);

    // Second tap on the SAME enemy: commits, HP drops, back to idle.
    clickTileCentre(h.input, h.renderer, { x: 3, y: 0 });
    expect(h.input.getState().kind).toBe('idle');
    expect(h.emitter.getState().units[enemyBefore.id]!.hp).toBeLessThan(100);
  });

  it('tapping a different enemy switches the preview without committing', () => {
    const h = intoAttackTargeting(true);
    const right = Object.values(h.emitter.getState().units).find(
      (u) => u.owner === 1 && u.pos.x === 3,
    )!;
    const left = Object.values(h.emitter.getState().units).find(
      (u) => u.owner === 1 && u.pos.x === 1,
    )!;

    clickTileCentre(h.input, h.renderer, { x: 3, y: 0 }); // preview right
    let s = h.input.getState();
    expect(s.kind === 'attack-targeting' && s.hover?.id).toBe(right.id);

    clickTileCentre(h.input, h.renderer, { x: 1, y: 0 }); // switch to left — no commit
    s = h.input.getState();
    expect(s.kind).toBe('attack-targeting');
    if (s.kind === 'attack-targeting') expect(s.hover?.id).toBe(left.id);
    // Neither enemy took damage across the switch.
    expect(h.emitter.getState().units[right.id]!.hp).toBe(100);
    expect(h.emitter.getState().units[left.id]!.hp).toBe(100);

    clickTileCentre(h.input, h.renderer, { x: 1, y: 0 }); // second tap on left commits
    expect(h.input.getState().kind).toBe('idle');
    expect(h.emitter.getState().units[left.id]!.hp).toBeLessThan(100);
  });

  it('fine pointer (mouse) commits on the FIRST click — unchanged behaviour', () => {
    const h = intoAttackTargeting(false);
    const right = Object.values(h.emitter.getState().units).find(
      (u) => u.owner === 1 && u.pos.x === 3,
    )!;
    clickTileCentre(h.input, h.renderer, { x: 3, y: 0 }); // one click commits
    expect(h.input.getState().kind).toBe('idle');
    expect(h.emitter.getState().units[right.id]!.hp).toBeLessThan(100);
  });
});
