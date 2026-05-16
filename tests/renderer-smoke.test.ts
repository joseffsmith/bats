// @vitest-environment jsdom
//
// Phase 3 smoke test: mount the renderer + input pipeline onto a JSDOM canvas,
// verify the state machine wires up, and confirm the damage preview matches
// the actual damage from a committed ATTACK.

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import duelMap from '../src/data/maps/duel.json';
import { loadMap } from '../src/engine/data/loader';
import { createEmitter } from '../src/renderer/emitter';
import { createCanvasRenderer } from '../src/renderer/canvas';
import { createInputController } from '../src/renderer/input';
import { createAnimationQueue } from '../src/renderer/animations';
import { previewAttack } from '../src/engine/systems/combat';
import { reduce } from '../src/engine/core/reducer';
import { setLogEnabled } from '../src/engine/core/logger';

setLogEnabled('engine', false);
setLogEnabled('render', false);

function mount() {
  // Reset DOM.
  document.body.innerHTML = '<div id="app"></div>';
  const canvas = document.createElement('canvas');
  document.getElementById('app')!.appendChild(canvas);
  // JSDOM doesn't implement getContext('2d') by default — stub one that
  // accepts the calls the renderer makes. We only need the methods invoked
  // during a draw + the property setters.
  if (!canvas.getContext('2d')) {
    // jsdom in v22+ ships a minimal 2D context — fall through if available.
  }
  const ctxStub = makeCtxStub();
  // Force getContext to return our stub regardless of JSDOM version.
  canvas.getContext = (type: string) => (type === '2d' ? ctxStub : null) as never;

  const state = loadMap(duelMap);
  const emitter = createEmitter(state);
  const renderer = createCanvasRenderer(canvas);
  renderer.resize();
  const animQueue = createAnimationQueue({ now: () => 0 });
  const input = createInputController(renderer, emitter, animQueue);
  return { canvas, emitter, renderer, input, animQueue, ctxStub };
}

function makeCtxStub(): CanvasRenderingContext2D {
  // Build a noop object exposing every CanvasRenderingContext2D method/prop
  // the renderer touches. We cast through `unknown` because the actual type is
  // huge and we don't need to implement most of it.
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
    save: noop,
    restore: noop,
    drawImage: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    quadraticCurveTo: noop,
    strokeText: noop,
    setLineDash: noop,
    lineDashOffset: 0,
    lineCap: 'butt',
    globalCompositeOperation: 'source-over',
    shadowColor: '#000',
    shadowBlur: 0,
    shadowOffsetY: 0,
  };
  return stub as unknown as CanvasRenderingContext2D;
}

describe('renderer smoke', () => {
  // JSDOM logs "Not implemented: HTMLCanvasElement's getContext()" via the
  // dom error virtual console even though we override `canvas.getContext`.
  // Suppress to keep test output clean.
  beforeAll(() => {
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
    // Force a reasonable viewport size; JSDOM defaults to 1024×768 which is
    // already desktop-sized, but be explicit.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
  });

  it('duel map loads with both HQs and infantry', () => {
    const { emitter } = mount();
    const state = emitter.getState();
    expect(state.players[0].hq).toEqual({ x: 1, y: 2 });
    expect(state.players[1].hq).toEqual({ x: 10, y: 2 });
    const units = Object.values(state.units);
    expect(units).toHaveLength(2);
    expect(units.every((u) => u.type === 'infantry')).toBe(true);
  });

  it('canvas dimensions reflect viewport × DPR', () => {
    const { canvas, renderer } = mount();
    const vp = renderer.getViewport();
    expect(vp.width).toBe(1024);
    expect(vp.height).toBe(768);
    // Desktop tile size.
    expect(vp.tileSize).toBe(48);
    // jsdom may report DPR=1.
    expect(canvas.width).toBe(Math.floor(1024 * vp.dpr));
    expect(canvas.height).toBe(Math.floor(768 * vp.dpr));
  });

  it('mobile breakpoint picks the 32px tile size', () => {
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const { renderer } = mount();
    expect(renderer.getViewport().tileSize).toBe(32);
  });

  it('clicking own infantry transitions input from idle to unit-selected', () => {
    const { input, renderer, emitter } = mount();
    expect(input.getState().kind).toBe('idle');
    // Player 0's infantry is at (2,2). Click its centre.
    const unit = Object.values(emitter.getState().units).find(
      (u) => u.owner === 0,
    )!;
    const pos = renderer.tileToPixel(unit.pos);
    const ts = renderer.getViewport().tileSize;
    input.click(pos.x + ts / 2, pos.y + ts / 2);
    const ms = input.getState();
    expect(ms.kind).toBe('unit-selected');
    if (ms.kind === 'unit-selected') {
      expect(ms.unit.id).toBe(unit.id);
      expect(ms.reachable.length).toBeGreaterThan(1);
    }
  });

  it('clicking off-grid cancels selection', () => {
    const { input, renderer, emitter } = mount();
    const unit = Object.values(emitter.getState().units).find(
      (u) => u.owner === 0,
    )!;
    const pos = renderer.tileToPixel(unit.pos);
    const ts = renderer.getViewport().tileSize;
    input.click(pos.x + ts / 2, pos.y + ts / 2);
    expect(input.getState().kind).toBe('unit-selected');
    input.click(0, 0); // top-left, far outside grid
    expect(input.getState().kind).toBe('idle');
  });

  it('end-turn (Enter key) advances currentPlayer', () => {
    // The end-turn button itself is now a DOM element rendered by chrome.ts
    // (not the canvas), so the legacy `renderer.getEndTurnRect()` API is
    // gone. Input still handles Enter as an end-turn shortcut — exercise
    // that path here.
    const { emitter } = mount();
    const before = emitter.getState().currentPlayer;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(emitter.getState().currentPlayer).not.toBe(before);
  });

  it('overlay highlights move range after selecting own unit', () => {
    const { input, renderer, emitter } = mount();
    const unit = Object.values(emitter.getState().units).find(
      (u) => u.owner === 0,
    )!;
    const pos = renderer.tileToPixel(unit.pos);
    const ts = renderer.getViewport().tileSize;
    input.click(pos.x + ts / 2, pos.y + ts / 2);
    const ov = input.getOverlay();
    expect(ov.selected).toEqual(unit.pos);
    expect(ov.moveRange?.length ?? 0).toBeGreaterThan(0);
  });

  it('damage preview matches actual damage from a committed attack', () => {
    // Construct adjacent infantry pair so previewAttack is exercisable.
    const { emitter } = mount();
    // Replace state with one where p0 infantry is adjacent to p1 infantry.
    const state = emitter.getState();
    const adjacent = structuredClone(state);
    const p0 = Object.values(adjacent.units).find((u) => u.owner === 0)!;
    const p1 = Object.values(adjacent.units).find((u) => u.owner === 1)!;
    // Move p1 next to p0 (still in bounds on duel map).
    p1.pos = { x: p0.pos.x + 1, y: p0.pos.y };
    emitter.setState(adjacent);

    const preview = previewAttack(emitter.getState(), p0.id, p1.id);
    const after = reduce(emitter.getState(), {
      type: 'ATTACK',
      attackerId: p0.id,
      targetId: p1.id,
    });
    const p1After = after.units[p1.id];
    const dealtActual = p1After ? p1.hp - p1After.hp : p1.hp;
    expect(preview.dealt).toBe(dealtActual);

    const p0After = after.units[p0.id];
    const counterActual = p0After ? p0.hp - p0After.hp : p0.hp;
    expect(preview.counterReceived).toBe(counterActual);
  });

  it('rendering does not throw with the default duel state', () => {
    const { renderer, emitter, input, animQueue } = mount();
    expect(() =>
      renderer.draw(emitter.getState(), input.getOverlay(), animQueue),
    ).not.toThrow();
  });

  it('right-click cancels back to idle', () => {
    const { input, renderer, emitter } = mount();
    const unit = Object.values(emitter.getState().units).find(
      (u) => u.owner === 0,
    )!;
    const pos = renderer.tileToPixel(unit.pos);
    const ts = renderer.getViewport().tileSize;
    input.click(pos.x + ts / 2, pos.y + ts / 2);
    expect(input.getState().kind).toBe('unit-selected');
    input.click(pos.x + ts / 2, pos.y + ts / 2, 2); // right-click button
    expect(input.getState().kind).toBe('idle');
  });

  it('clicking own factory tile opens build menu', () => {
    const { input, renderer, emitter } = mount();
    // Player 0's factory: per duel.json, "a" at row 3 char 1 → (1,3).
    // We move the infantry away so the factory tile is unoccupied (it already is).
    const state = emitter.getState();
    expect(state.map[3]![1]!.terrain).toBe('factory');
    expect(state.map[3]![1]!.owner).toBe(0);
    const pos = renderer.tileToPixel({ x: 1, y: 3 });
    const ts = renderer.getViewport().tileSize;
    input.click(pos.x + ts / 2, pos.y + ts / 2);
    expect(input.getState().kind).toBe('build-menu-open');
  });
});
