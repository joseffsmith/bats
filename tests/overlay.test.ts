// @vitest-environment jsdom
//
// Range-overlay redesign (SMOKE_TEST.md UI review #1, "Range overlays turn to
// mud"). These lock in the getOverlay() contract that keeps the move-range
// (blue) and attack-range (red) overlays as DISJOINT sets so they can't stack
// into ambiguous mauve, and the capturable-wash gate that only paints for a
// unit that can actually capture.
//
// Pure state-machine assertions — the drawing (borders, alphas) is exercised by
// the visual goldens, not here.

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { createEmitter } from '../src/renderer/emitter';
import { createCanvasRenderer } from '../src/renderer/canvas';
import { createInputController, __test } from '../src/renderer/input';
import { createAnimationQueue } from '../src/renderer/animations';
import { reachableTiles } from '../src/engine/queries/selectors';
import { setLogEnabled } from '../src/engine/core/logger';
import { makeState } from './test-helpers';
import type { Coord, GameState, Unit } from '../src/engine/core/types';

setLogEnabled('engine', false);
setLogEnabled('render', false);

// ─── Mount harness (mirrors input-state-machine.test.ts) ─────────────────────

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

function clickTileCentre(
  input: ReturnType<typeof mount>['input'],
  renderer: ReturnType<typeof mount>['renderer'],
  tile: Coord,
): void {
  const ts = renderer.getViewport().tileSize;
  const px = renderer.tileToPixel(tile);
  input.click(px.x + ts / 2, px.y + ts / 2);
}

const key = (c: Coord): string => `${c.x},${c.y}`;
const keySet = (cs: Coord[] | undefined): Set<string> =>
  new Set((cs ?? []).map(key));
const ownUnit = (state: GameState, pred: (u: Unit) => boolean): Unit =>
  Object.values(state.units).find((u) => u.owner === 0 && pred(u))!;

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
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
});

// ─── Direct unit: fringe is disjoint from move range ─────────────────────────

describe('unit-selected overlay: direct unit', () => {
  it('moveRange ∩ attackRange = ∅ and attackRange is exactly the fringe', () => {
    // Tank (direct, range 1) on an open plain — its reachable region is a
    // diamond and the attack fringe is the 1-tile ring hugging it.
    const state = makeState({
      width: 12,
      height: 9,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 11, y: 8 } },
      ],
      units: [{ type: 'tank', owner: 0, pos: { x: 5, y: 4 } }],
    });
    const { input, emitter } = mount(state);
    const tank = ownUnit(emitter.getState(), (u) => u.type === 'tank');
    input.selectUnit(tank);
    expect(input.getState().kind).toBe('unit-selected');

    const ov = input.getOverlay();
    expect(ov.moveRange && ov.moveRange.length).toBeGreaterThan(0);
    expect(ov.attackRange && ov.attackRange.length).toBeGreaterThan(0);

    // Disjoint: no red tile is also a blue tile.
    const move = keySet(ov.moveRange);
    for (const c of ov.attackRange ?? []) {
      expect(move.has(key(c))).toBe(false);
    }

    // Exactly the fringe: computeAttackArea over the reachable set, minus the
    // reachable tiles. Recomputed independently from the engine selectors.
    const reach = reachableTiles(state, tank);
    const reachKeys = keySet(reach.map((r) => r.coord));
    const expected = new Set(
      __test
        .computeAttackArea(state, tank, reach)
        .map(key)
        .filter((k) => !reachKeys.has(k)),
    );
    expect(keySet(ov.attackRange)).toEqual(expected);
  });
});

// ─── Indirect unit: donut survives the subtraction ───────────────────────────

describe('unit-selected overlay: indirect unit (artillery)', () => {
  it('keeps the full minRange..maxRange donut when boxed in', () => {
    // Artillery (tread, range [2,3]) marooned on a lone plain tile in a sea of
    // impassable water: it can't move (reachable = {self}), so the attack ring
    // never intersects the move range and the whole donut survives.
    const state = makeState({
      width: 9,
      height: 9,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 8, y: 8 } },
      ],
      tiles: [{ pos: { x: 4, y: 4 }, terrain: 'plain' }],
      units: [{ type: 'artillery', owner: 0, pos: { x: 4, y: 4 } }],
    });
    const { input, emitter } = mount(state);
    const art = ownUnit(emitter.getState(), (u) => u.type === 'artillery');
    input.selectUnit(art);
    const ov = input.getOverlay();

    // Boxed in: the only move tile is the artillery's own tile.
    expect(keySet(ov.moveRange)).toEqual(new Set([key({ x: 4, y: 4 })]));

    // The donut = every in-bounds tile at Manhattan distance ∈ [2,3] from the
    // centre. On a 9×9 board centred at (4,4) all such tiles are in bounds:
    // 4·2 + 4·3 = 20 tiles.
    const donut = new Set<string>();
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const d = Math.abs(x - 4) + Math.abs(y - 4);
        if (d >= 2 && d <= 3) donut.add(key({ x, y }));
      }
    }
    expect(donut.size).toBe(20);
    expect(keySet(ov.attackRange)).toEqual(donut);

    // Spot checks: centre excluded (minRange), adjacent excluded (< minRange),
    // ring tiles present, and disjoint from the (self-only) move range.
    expect(keySet(ov.attackRange).has(key({ x: 4, y: 4 }))).toBe(false);
    expect(keySet(ov.attackRange).has(key({ x: 5, y: 4 }))).toBe(false); // d=1
    expect(keySet(ov.attackRange).has(key({ x: 6, y: 4 }))).toBe(true); // d=2
    expect(keySet(ov.attackRange).has(key({ x: 7, y: 4 }))).toBe(true); // d=3
    const move = keySet(ov.moveRange);
    for (const c of ov.attackRange ?? []) expect(move.has(key(c))).toBe(false);

    // Boxed in, the border trace equals the fill (nothing was subtracted).
    expect(keySet(ov.attackRangeBorder)).toEqual(donut);
  });

  it('traces the full donut via attackRangeBorder on open ground', () => {
    // Artillery on open plains: its move range covers the entire dist-2..3
    // donut, so the subtracted red FILL empties — but the border trace must
    // still carry the full donut, because an indirect unit can only fire from
    // where it already stands. Losing the ring here would hide the unit's
    // entire this-turn threat.
    const state = makeState({
      width: 11,
      height: 11,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 10, y: 10 } },
      ],
      units: [{ type: 'artillery', owner: 0, pos: { x: 5, y: 5 } }],
    });
    const { input, emitter } = mount(state);
    const art = ownUnit(emitter.getState(), (u) => u.type === 'artillery');
    input.selectUnit(art);
    const ov = input.getOverlay();

    const donut = new Set<string>();
    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 11; x++) {
        const d = Math.abs(x - 5) + Math.abs(y - 5);
        if (d >= 2 && d <= 3) donut.add(key({ x, y }));
      }
    }
    expect(keySet(ov.attackRangeBorder)).toEqual(donut);
    // Every donut tile is reachable on open ground, so the fill is empty.
    expect(ov.attackRange ?? []).toHaveLength(0);
  });

  it('leaves attackRangeBorder unset for direct units', () => {
    const state = makeState({
      width: 9,
      height: 9,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 8, y: 8 } },
      ],
      units: [{ type: 'tank', owner: 0, pos: { x: 4, y: 4 } }],
    });
    const { input, emitter } = mount(state);
    const tank = ownUnit(emitter.getState(), (u) => u.type === 'tank');
    input.selectUnit(tank);
    expect(input.getOverlay().attackRangeBorder).toBeUndefined();
  });
});

// ─── move-previewed carries the same fringe as unit-selected ─────────────────

describe('move-previewed overlay parity', () => {
  it('attackRange in move-previewed equals unit-selected for the same unit', () => {
    const state = makeState({
      width: 12,
      height: 9,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 11, y: 8 } },
      ],
      units: [{ type: 'tank', owner: 0, pos: { x: 5, y: 4 } }],
    });
    const { input, renderer, emitter } = mount(state);
    const tank = ownUnit(emitter.getState(), (u) => u.type === 'tank');

    clickTileCentre(input, renderer, tank.pos); // select
    expect(input.getState().kind).toBe('unit-selected');
    const selectedAttack = keySet(input.getOverlay().attackRange);

    clickTileCentre(input, renderer, { x: 6, y: 4 }); // preview a move
    expect(input.getState().kind).toBe('move-previewed');
    const previewAttack = keySet(input.getOverlay().attackRange);

    // Same set — the fringe is anchored on the FULL reachable set, not the
    // previewed destination, so it doesn't shift when a tile is previewed.
    expect(previewAttack).toEqual(selectedAttack);
    expect(previewAttack.size).toBeGreaterThan(0);
  });
});

// ─── Capturable wash gating ──────────────────────────────────────────────────

describe('capturable wash', () => {
  function stateWithCity(): GameState {
    return makeState({
      width: 8,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 7, y: 4 } },
      ],
      tiles: [{ pos: { x: 3, y: 2 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 2 } },
        { type: 'tank', owner: 0, pos: { x: 2, y: 2 } },
      ],
    });
  }

  it('is absent in idle (no permanent wash)', () => {
    const { input } = mount(stateWithCity());
    expect(input.getState().kind).toBe('idle');
    expect(input.getOverlay().capturable).toBeUndefined();
  });

  it('is present when a capturing unit (infantry) is selected', () => {
    const { input, emitter } = mount(stateWithCity());
    const inf = ownUnit(emitter.getState(), (u) => u.type === 'infantry');
    input.selectUnit(inf);
    const cap = input.getOverlay().capturable;
    expect(cap).toBeDefined();
    // The neutral city is among the highlighted tiles.
    expect(keySet(cap).has(key({ x: 3, y: 2 }))).toBe(true);
  });

  it('is absent when a non-capturing unit (tank) is selected', () => {
    const { input, emitter } = mount(stateWithCity());
    const tank = ownUnit(emitter.getState(), (u) => u.type === 'tank');
    input.selectUnit(tank);
    expect(input.getOverlay().capturable).toBeUndefined();
  });
});
