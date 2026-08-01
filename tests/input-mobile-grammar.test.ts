// @vitest-environment jsdom
//
// The mobile input grammar: select → stage → commit.
//
// The contract these tests pin down, in order of how much it would hurt to
// break it:
//
//   1. Tap 1 and tap 2 NEVER change the game state. Not the unit's position,
//      not its flags, not an enemy's HP. Staging is a UI-side promise only.
//   2. Tap 3 on the staged tile commits, and commits as a SEQUENCE of the
//      existing engine actions — ['MOVE','ATTACK'], ['MOVE','CAPTURE'],
//      ['MOVE','WAIT'] — with no new reducer action types involved.
//   3. A confirming tap that lands within 150ms of staging is a double-tap,
//      not a decision, and is dropped.
//   4. None of this exists under the default (desktop) grammar.
//
// Action order is asserted against the emitter's dispatch stream rather than
// the resulting state, because the ORDER is the thing that's easy to get wrong.

import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { createEmitter } from '../src/renderer/emitter';
import { createCanvasRenderer } from '../src/renderer/canvas';
import { createInputController, __test } from '../src/renderer/input';
import { createAnimationQueue } from '../src/renderer/animations';
import { reachableTiles } from '../src/engine/queries/selectors';
import { previewAttack } from '../src/engine/systems/combat';
import { setLogEnabled } from '../src/engine/core/logger';
import { makeState } from './test-helpers';
import type { Coord, GameState, Unit } from '../src/engine/core/types';

setLogEnabled('engine', false);
setLogEnabled('render', false);

// ─── Mount harness (mirrors tests/input-state-machine.test.ts) ──────────────

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

/** Start the clock well past the debounce window so `t - 0` can't sneak through. */
const T0 = 10_000;

function mount(state: GameState, opts?: { grammar?: 'desktop' | 'mobile' }) {
  document.body.innerHTML = '<div id="app"></div>';
  const canvas = document.createElement('canvas');
  document.getElementById('app')!.appendChild(canvas);
  canvas.getContext = (type: string) =>
    (type === '2d' ? makeCtxStub() : null) as never;
  const emitter = createEmitter(state);
  const renderer = createCanvasRenderer(canvas);
  renderer.resize();
  const clock = { t: T0 };
  const now = (): number => clock.t;
  const animQueue = createAnimationQueue({ now });
  const grammar = opts?.grammar ?? 'mobile';
  const input = createInputController(renderer, emitter, animQueue, {
    grammar,
    now,
    coarsePointer: grammar === 'mobile',
  });
  // Dispatch stream: the emitter only carries a non-null `action` when the
  // reducer actually changed the state, so this is exactly "what was committed".
  const actions: string[] = [];
  emitter.on((ev) => {
    if (ev.type === 'stateChanged' && ev.action) actions.push(ev.action.type);
  });

  const tap = (tile: Coord): void => {
    const ts = renderer.getViewport().tileSize;
    const px = renderer.tileToPixel(tile);
    input.click(px.x + ts / 2, px.y + ts / 2);
  };
  /** Push past the stage debounce (and let any queued animation retire). */
  const wait = (ms: number): void => {
    clock.t += ms;
    animQueue.tick();
  };
  const unit = (owner: 0 | 1, type?: string): Unit => {
    const u = Object.values(emitter.getState().units).find(
      (x) => x.owner === owner && (type === undefined || x.type === type),
    );
    if (!u) throw new Error(`no unit for player ${owner}`);
    return u;
  };

  return { canvas, emitter, renderer, input, animQueue, clock, actions, tap, wait, unit };
}

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

// ─── Boards ────────────────────────────────────────────────────────────────

/**
 *   y=0: hq(p0)  .        .        .      .   .
 *   y=1: .       INF(p0)  .        INF(p1) .  .
 *   y=2: .       .        .        .      .   hq(p1)
 */
function skirmish(extra?: Parameters<typeof makeState>[0]['tiles']): GameState {
  return makeState({
    width: 6,
    height: 3,
    defaultTerrain: 'plain',
    hqs: [
      { owner: 0, pos: { x: 0, y: 0 } },
      { owner: 1, pos: { x: 5, y: 2 } },
    ],
    ...(extra ? { tiles: extra } : {}),
    units: [
      { type: 'infantry', owner: 0, pos: { x: 1, y: 1 } },
      { type: 'infantry', owner: 1, pos: { x: 3, y: 1 } },
    ],
  });
}

// ─── Tap 1: select / inspect ───────────────────────────────────────────────

describe('mobile grammar — tap 1 selects or inspects, never commits', () => {
  it('tapping an own unit selects it', () => {
    const h = mount(skirmish());
    h.tap({ x: 1, y: 1 });
    expect(h.input.getState().kind).toBe('unit-selected');
    expect(h.actions).toEqual([]);
  });

  it('tapping an enemy opens enemy-inspect with the threat overlay ON', () => {
    const h = mount(skirmish());
    const enemy = h.unit(1);
    h.tap({ x: 3, y: 1 });
    const s = h.input.getState();
    expect(s.kind).toBe('enemy-inspect');
    if (s.kind !== 'enemy-inspect') return;
    expect(s.unit.id).toBe(enemy.id);
    // Threat is the default read: the tap asks "what can this thing hit".
    expect(s.showThreat).toBe(true);
    const ov = h.input.getOverlay();
    expect(ov.attackRange?.length).toBeGreaterThan(0);
    expect(ov.attackRangeBorder?.length).toBe(ov.attackRange?.length);
    // The enemy infantry can walk to (2,1) and swing at our tile from there.
    expect(ov.attackRange?.some((c) => c.x === 1 && c.y === 1)).toBe(true);
    expect(h.input.getOverlay().selected).toEqual({ x: 3, y: 1 });
    expect(h.actions).toEqual([]);
  });

  it('toggleThreat un-paints (and re-paints) everything that enemy could hit', () => {
    const h = mount(skirmish());
    h.tap({ x: 3, y: 1 });
    h.input.toggleThreat();
    const off = h.input.getState();
    expect(off.kind === 'enemy-inspect' && off.showThreat).toBe(false);
    expect(h.input.getOverlay().attackRange).toBeUndefined();

    h.input.toggleThreat();
    const on = h.input.getState();
    expect(on.kind === 'enemy-inspect' && on.showThreat).toBe(true);
    const ov = h.input.getOverlay();
    expect(ov.attackRange?.length).toBeGreaterThan(0);
    expect(ov.attackRangeBorder?.length).toBe(ov.attackRange?.length);
    expect(h.actions).toEqual([]);
  });

  it('tapping bare terrain opens tile-inspect', () => {
    const h = mount(skirmish());
    h.tap({ x: 4, y: 0 });
    const s = h.input.getState();
    expect(s.kind).toBe('tile-inspect');
    if (s.kind === 'tile-inspect') expect(s.tile).toEqual({ x: 4, y: 0 });
    expect(h.actions).toEqual([]);
  });

  it('tapping an own spent unit inspects its tile rather than sticking', () => {
    const state = skirmish();
    Object.values(state.units).find((u) => u.owner === 0)!.hasActed = true;
    const h = mount(state);
    h.tap({ x: 1, y: 1 });
    expect(h.input.getState().kind).toBe('tile-inspect');
    expect(h.actions).toEqual([]);
  });

  it('tapping an own empty factory goes straight to the build menu', () => {
    const state = skirmish([{ pos: { x: 2, y: 0 }, terrain: 'factory', owner: 0 }]);
    state.players[0].funds = 99_999;
    const h = mount(state);
    h.tap({ x: 2, y: 0 });
    expect(h.input.getState().kind).toBe('build-menu-open');
    expect(h.actions).toEqual([]);
  });
});

// ─── Tap 2: stage ──────────────────────────────────────────────────────────

describe('mobile grammar — tap 2 stages a verb, never commits', () => {
  it('a reachable tile stages a move and leaves the unit exactly where it was', () => {
    const h = mount(skirmish());
    const before = h.unit(0);
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 2, y: 1 });
    const s = h.input.getState();
    expect(s.kind).toBe('move-previewed');
    if (s.kind !== 'move-previewed') return;
    expect(s.destination).toEqual({ x: 2, y: 1 });
    expect(s.path.length).toBeGreaterThan(0);
    expect(s.stagedAt).toBe(T0);
    // Nothing committed: same tile, same flags.
    const after = h.emitter.getState().units[before.id]!;
    expect(after.pos).toEqual({ x: 1, y: 1 });
    expect(after.hasMoved).toBe(false);
    expect(after.hasActed).toBe(false);
    expect(h.actions).toEqual([]);
  });

  it('an enemy in reach stages an attack with an auto-picked firing tile', () => {
    const h = mount(skirmish());
    const enemy = h.unit(1);
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 3, y: 1 });
    const s = h.input.getState();
    expect(s.kind).toBe('attack-staged');
    if (s.kind !== 'attack-staged') return;
    expect(s.target.id).toBe(enemy.id);
    expect(s.firingPos).toEqual({ x: 2, y: 1 }); // cheapest adjacent plain tile
    expect(s.path).toEqual([{ x: 2, y: 1 }]);
    // The forecast the tray will show comes straight from the engine.
    const forecast = previewAttack(h.emitter.getState(), s.unit.id, s.target.id);
    expect(forecast.dealt).toBeGreaterThan(0);
    // Still nothing committed.
    expect(h.emitter.getState().units[enemy.id]!.hp).toBe(100);
    expect(h.actions).toEqual([]);
  });

  it('overlays the staged attack with existing fields only', () => {
    const h = mount(skirmish());
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 3, y: 1 });
    const ov = h.input.getOverlay();
    expect(ov.selected).toEqual({ x: 2, y: 1 });
    expect(ov.movePath).toEqual([{ x: 2, y: 1 }]);
    expect(ov.attackRange).toEqual([{ x: 3, y: 1 }]);
    expect(ov.damagePreview?.tile).toEqual({ x: 3, y: 1 });
  });

  it('a capturable property stages a capture', () => {
    const state = skirmish([{ pos: { x: 2, y: 1 }, terrain: 'city', owner: null }]);
    const h = mount(state);
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 2, y: 1 });
    const s = h.input.getState();
    expect(s.kind).toBe('capture-staged');
    if (s.kind !== 'capture-staged') return;
    expect(s.destination).toEqual({ x: 2, y: 1 });
    expect(h.actions).toEqual([]);
  });

  it('an indirect unit stages attack-in-place with an empty path', () => {
    const state = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 2 } },
      ],
      units: [
        { type: 'artillery', owner: 0, pos: { x: 2, y: 1 } },
        { type: 'tank', owner: 1, pos: { x: 4, y: 1 } },
      ],
    });
    const h = mount(state);
    h.tap({ x: 2, y: 1 });
    h.tap({ x: 4, y: 1 });
    const s = h.input.getState();
    expect(s.kind).toBe('attack-staged');
    if (s.kind !== 'attack-staged') return;
    expect(s.firingPos).toEqual({ x: 2, y: 1 });
    expect(s.path).toEqual([]);
    expect(h.actions).toEqual([]);
  });

  it('an out-of-range enemy is not stageable for an indirect unit', () => {
    const state = makeState({
      width: 8,
      height: 1,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 7, y: 0 } },
      ],
      units: [
        { type: 'artillery', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'tank', owner: 1, pos: { x: 6, y: 0 } },
      ],
    });
    const h = mount(state);
    h.tap({ x: 2, y: 0 });
    h.tap({ x: 6, y: 0 });
    expect(h.input.getState().kind).toBe('idle');
    expect(h.actions).toEqual([]);
  });

  it('tapping the unit’s own (unremarkable) tile opens the orders menu', () => {
    const h = mount(skirmish());
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 1, y: 1 });
    expect(h.input.getState().kind).toBe('action-menu');
    expect(h.actions).toEqual([]);
  });

  it('tapping another own unit switches the selection', () => {
    const state = skirmish();
    state.units['u9'] = {
      id: 'u9',
      type: 'tank',
      owner: 0,
      pos: { x: 1, y: 2 },
      hp: 100,
      hasMoved: false,
      hasActed: false,
      captureProgress: 0,
    };
    const h = mount(state);
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 1, y: 2 });
    const s = h.input.getState();
    expect(s.kind).toBe('unit-selected');
    if (s.kind === 'unit-selected') expect(s.unit.id).toBe('u9');
    expect(h.actions).toEqual([]);
  });
});

// ─── Re-staging ────────────────────────────────────────────────────────────

describe('mobile grammar — a tap on another legal target re-stages', () => {
  it('switches the attack target without committing', () => {
    const state = skirmish();
    state.units['u9'] = {
      id: 'u9',
      type: 'infantry',
      owner: 1,
      pos: { x: 2, y: 2 },
      hp: 100,
      hasMoved: false,
      hasActed: false,
      captureProgress: 0,
    };
    const h = mount(state);
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 3, y: 1 });
    expect(h.input.getState().kind).toBe('attack-staged');
    h.wait(500);
    h.tap({ x: 2, y: 2 }); // a DIFFERENT enemy — re-stage, never commit
    const s = h.input.getState();
    expect(s.kind).toBe('attack-staged');
    if (s.kind === 'attack-staged') {
      expect(s.target.id).toBe('u9');
      expect(s.stagedAt).toBe(T0 + 500);
    }
    expect(h.actions).toEqual([]);
    expect(h.emitter.getState().units['u9']!.hp).toBe(100);
  });

  it('moves the staged destination without committing', () => {
    const h = mount(skirmish());
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 2, y: 1 });
    h.wait(500);
    h.tap({ x: 1, y: 2 });
    const s = h.input.getState();
    expect(s.kind).toBe('move-previewed');
    if (s.kind === 'move-previewed') {
      expect(s.destination).toEqual({ x: 1, y: 2 });
      expect(s.stagedAt).toBe(T0 + 500);
    }
    expect(h.actions).toEqual([]);
  });

  it('a tap on nothing legal deselects', () => {
    const h = mount(skirmish());
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 2, y: 1 });
    h.wait(500);
    h.tap({ x: 5, y: 0 }); // far out of the move budget
    expect(h.input.getState().kind).toBe('idle');
    expect(h.actions).toEqual([]);
  });

  it('cancel() drops the staged action without dispatching', () => {
    const h = mount(skirmish());
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 3, y: 1 });
    h.input.cancel();
    expect(h.input.getState().kind).toBe('idle');
    expect(h.actions).toEqual([]);
    expect(h.emitter.getState().units[h.unit(1).id]!.hp).toBe(100);
  });
});

// ─── Tap 3: commit ─────────────────────────────────────────────────────────

describe('mobile grammar — tap 3 commits a sequence of existing actions', () => {
  it('move: MOVE then WAIT when nothing is left to do at the destination', () => {
    const h = mount(skirmish());
    const id = h.unit(0).id;
    h.tap({ x: 1, y: 1 });
    // (1,2) is out of the enemy's reach entirely: no attack, no capture, no
    // cargo — the move IS the unit's turn, so the implicit WAIT closes it out.
    h.tap({ x: 1, y: 2 });
    h.wait(200);
    h.tap({ x: 1, y: 2 });
    expect(h.actions).toEqual(['MOVE', 'WAIT']);
    const moved = h.emitter.getState().units[id]!;
    expect(moved.pos).toEqual({ x: 1, y: 2 });
    expect(moved.hasActed).toBe(true);
    expect(h.input.getState().kind).toBe('idle');
  });

  it('move: landing beside an enemy opens the orders menu — attack after moving is honoured', () => {
    const h = mount(skirmish());
    const enemy = h.unit(1).id;
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 2, y: 1 }); // adjacent to the enemy at (3,1)
    h.wait(200);
    h.tap({ x: 2, y: 1 }); // confirm the move
    // No implicit WAIT: the unit can still attack from here, so the MOVE lands
    // alone and the orders menu asks.
    expect(h.actions).toEqual(['MOVE']);
    const s = h.input.getState();
    expect(s.kind).toBe('action-menu');
    if (s.kind !== 'action-menu') return;
    const enabled = s.entries.filter((e) => e.enabled).map((e) => e.label);
    expect(enabled).toContain('Attack');
    // Follow through: Attack → two-tap target confirm → ATTACK commits.
    h.input.chooseAction('Attack');
    expect(h.input.getState().kind).toBe('attack-targeting');
    h.wait(1000); // let the MOVE animation retire so taps aren't swallowed
    h.tap({ x: 3, y: 1 }); // first tap previews the damage (coarse pointer)
    h.tap({ x: 3, y: 1 }); // second tap commits
    expect(h.actions).toEqual(['MOVE', 'ATTACK']);
    expect(h.emitter.getState().units[enemy]!.hp).toBeLessThan(100);
  });

  it('move: a transport with cargo can still unload after moving', () => {
    const state = makeState({
      width: 6,
      height: 1,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 0 } },
      ],
      tiles: [
        { pos: { x: 2, y: 0 }, terrain: 'sea' },
        { pos: { x: 3, y: 0 }, terrain: 'sea' },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'transport', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 5, y: 0 } },
      ],
    });
    const h = mount(state);
    const inf = h.unit(0, 'infantry').id;
    // Board the transport…
    h.tap({ x: 1, y: 0 });
    h.tap({ x: 2, y: 0 });
    h.wait(200);
    h.tap({ x: 2, y: 0 });
    expect(h.actions).toEqual(['LOAD']);
    // …then move the transport and unload at the new position. Pre-fix this
    // path was impossible: the bare move auto-WAITed and stranded the cargo.
    h.wait(1000);
    h.tap({ x: 2, y: 0 });
    h.tap({ x: 3, y: 0 });
    h.wait(200);
    h.tap({ x: 3, y: 0 });
    expect(h.actions).toEqual(['LOAD', 'MOVE']);
    const s = h.input.getState();
    expect(s.kind).toBe('action-menu');
    if (s.kind !== 'action-menu') return;
    expect(s.entries.filter((e) => e.enabled).map((e) => e.label)).toContain(
      'Unload',
    );
    h.input.chooseAction('Unload');
    expect(h.input.getState().kind).toBe('unload-targeting');
    h.wait(1000);
    h.tap({ x: 4, y: 0 }); // the only foot-passable adjacent tile
    expect(h.actions).toEqual(['LOAD', 'MOVE', 'UNLOAD']);
    const dropped = h.emitter.getState().units[inf]!;
    expect(dropped.loadedIn).toBeUndefined();
    expect(dropped.pos).toEqual({ x: 4, y: 0 });
  });

  it('attack: MOVE then ATTACK, in that order', () => {
    const h = mount(skirmish());
    const attacker = h.unit(0).id;
    const enemy = h.unit(1).id;
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 3, y: 1 });
    h.wait(200);
    h.tap({ x: 3, y: 1 });
    expect(h.actions).toEqual(['MOVE', 'ATTACK']);
    const state = h.emitter.getState();
    expect(state.units[attacker]!.pos).toEqual({ x: 2, y: 1 });
    expect(state.units[attacker]!.hasActed).toBe(true);
    expect(state.units[enemy]!.hp).toBeLessThan(100);
    expect(h.input.getState().kind).toBe('idle');
  });

  it('attack in place: ATTACK only, no MOVE', () => {
    const state = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 2 } },
      ],
      units: [
        { type: 'artillery', owner: 0, pos: { x: 2, y: 1 } },
        { type: 'tank', owner: 1, pos: { x: 4, y: 1 } },
      ],
    });
    const h = mount(state);
    const art = h.unit(0).id;
    const tank = h.unit(1).id;
    h.tap({ x: 2, y: 1 });
    h.tap({ x: 4, y: 1 });
    h.wait(200);
    h.tap({ x: 4, y: 1 });
    expect(h.actions).toEqual(['ATTACK']);
    expect(h.emitter.getState().units[art]!.pos).toEqual({ x: 2, y: 1 });
    expect(h.emitter.getState().units[tank]!.hp).toBeLessThan(100);
  });

  it('capture: MOVE then CAPTURE', () => {
    // The enemy is parked far from the city so the follow-up isn't ambiguous —
    // but it has to EXIST, or the MOVE routs player 1 and ends the game before
    // the CAPTURE can land.
    const state = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 2 } },
      ],
      tiles: [{ pos: { x: 2, y: 1 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 1 } },
        { type: 'infantry', owner: 1, pos: { x: 5, y: 0 } },
      ],
    });
    const h = mount(state);
    const id = h.unit(0).id;
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 2, y: 1 });
    h.wait(200);
    h.tap({ x: 2, y: 1 });
    expect(h.actions).toEqual(['MOVE', 'CAPTURE']);
    expect(h.emitter.getState().units[id]!.captureProgress).toBe(10);
    expect(h.input.getState().kind).toBe('idle');
  });

  it('capture in place: CAPTURE only, no MOVE', () => {
    const state = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 2 } },
      ],
      tiles: [{ pos: { x: 1, y: 1 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 1 } },
        { type: 'infantry', owner: 1, pos: { x: 5, y: 0 } },
      ],
    });
    const h = mount(state);
    const id = h.unit(0).id;
    h.tap({ x: 1, y: 1 }); // select
    h.tap({ x: 1, y: 1 }); // stage capture in place
    expect(h.input.getState().kind).toBe('capture-staged');
    h.wait(200);
    h.tap({ x: 1, y: 1 }); // commit
    expect(h.actions).toEqual(['CAPTURE']);
    expect(h.emitter.getState().units[id]!.captureProgress).toBe(10);
  });

  it('genuinely ambiguous follow-up: MOVE alone, then the orders menu', () => {
    // Infantry lands on a neutral city with an enemy adjacent: capture AND
    // attack are both live, so the grammar stops and asks.
    const state = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 2 } },
      ],
      tiles: [{ pos: { x: 2, y: 1 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 1 } },
        { type: 'infantry', owner: 1, pos: { x: 3, y: 1 } },
      ],
    });
    const h = mount(state);
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 2, y: 1 });
    expect(h.input.getState().kind).toBe('capture-staged');
    h.wait(200);
    h.tap({ x: 2, y: 1 });
    expect(h.actions).toEqual(['MOVE']);
    const s = h.input.getState();
    expect(s.kind).toBe('action-menu');
    if (s.kind !== 'action-menu') return;
    expect(s.anchor).toEqual({ x: 2, y: 1 });
    const labels = s.entries.map((e) => e.label);
    expect(labels).toContain('Capture');
    expect(labels).toContain('Attack');
  });
});

describe('mobile grammar — boarding a transport', () => {
  it('stages the boarding tile and commits it as a LOAD, not a MOVE', () => {
    // LOAD is the engine's single action for "walk aboard": the transport's
    // tile is a legal terminal node that a MOVE could never stop on.
    const state = makeState({
      width: 6,
      height: 1,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 0 } },
      ],
      tiles: [{ pos: { x: 3, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'transport', owner: 0, pos: { x: 3, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 5, y: 0 } },
      ],
    });
    const h = mount(state);
    const inf = h.unit(0, 'infantry').id;
    const boat = h.unit(0, 'transport').id;
    h.tap({ x: 1, y: 0 });
    h.tap({ x: 3, y: 0 });
    expect(h.input.getState().kind).toBe('move-previewed');
    expect(h.actions).toEqual([]);
    h.wait(200);
    h.tap({ x: 3, y: 0 });
    expect(h.actions).toEqual(['LOAD']);
    expect(h.emitter.getState().units[inf]!.loadedIn).toBe(boat);
    expect(h.input.getState().kind).toBe('idle');
  });
});

// ─── Staged-move attack radar ──────────────────────────────────────────────
//
// Confirming a staged move is the unit's whole turn (MOVE + WAIT), so the
// staging tap paints the attack RADAR: everywhere the unit could strike NEXT
// turn from the staged destination. The border carries the full radar; the
// fill keeps the disjoint-from-blue rule the range overlays established.

describe('mobile grammar — a staged move paints the next-turn attack radar', () => {
  const key = (c: Coord): string => `${c.x},${c.y}`;
  const keySet = (cs: Coord[] | undefined): Set<string> =>
    new Set((cs ?? []).map(key));

  it('anchors the radar at the staged destination, past this-turn reach', () => {
    const state = makeState({
      width: 12,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 11, y: 4 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 2 } },
        { type: 'infantry', owner: 1, pos: { x: 11, y: 4 } },
      ],
    });
    const h = mount(state);
    const inf = h.unit(0);
    h.tap({ x: 1, y: 2 });
    h.tap({ x: 4, y: 2 });
    expect(h.input.getState().kind).toBe('move-previewed');

    const ov = h.input.getOverlay();
    // Recompute independently: ghost the unit onto the destination with a
    // fresh turn and take its attack area over its reach from there.
    const live = h.emitter.getState();
    const ghost: Unit = { ...inf, pos: { x: 4, y: 2 } };
    const ghostState: GameState = {
      ...live,
      units: { ...live.units, [inf.id]: ghost },
    };
    const expected = keySet(
      __test.computeAttackArea(
        ghostState,
        ghost,
        reachableTiles(ghostState, ghost),
      ),
    );
    expect(expected.size).toBeGreaterThan(0);
    expect(keySet(ov.attackRangeBorder)).toEqual(expected);
    // (8,2) is move 3 + range 1 out from the DESTINATION. The farthest strike
    // this turn (from (1,2)) is x=5, so only a destination-anchored next-turn
    // radar can contain it.
    expect(keySet(ov.attackRangeBorder).has(key({ x: 8, y: 2 }))).toBe(true);
    // Disjoint-fill rule: the red fill never lands on a blue move tile.
    const move = keySet(ov.moveRange);
    for (const c of ov.attackRange ?? []) expect(move.has(key(c))).toBe(false);
    // Staging still commits nothing.
    expect(h.actions).toEqual([]);
  });

  it('gives an indirect unit its donut around the destination — the "park the artillery" read', () => {
    const state = makeState({
      width: 10,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 9, y: 2 } },
      ],
      units: [
        { type: 'artillery', owner: 0, pos: { x: 1, y: 1 } },
        { type: 'infantry', owner: 1, pos: { x: 9, y: 2 } },
      ],
    });
    const h = mount(state);
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 3, y: 1 });
    expect(h.input.getState().kind).toBe('move-previewed');
    const border = keySet(h.input.getOverlay().attackRangeBorder);
    // The [2,3] donut around the DESTINATION (3,1), not around where the
    // artillery currently stands: (6,1) is d=3 from the destination but d=5
    // from (1,1), so the old this-turn donut never contained it.
    expect(border.has(key({ x: 6, y: 1 }))).toBe(true);
    expect(border.has(key({ x: 4, y: 1 }))).toBe(false); // d=1 < minRange
    expect(border.has(key({ x: 3, y: 1 }))).toBe(false); // the tile itself
    expect(border.has(key({ x: 1, y: 1 }))).toBe(true); // old tile, d=2
    expect(h.actions).toEqual([]);
  });

  it('paints no radar when the staged tile boards a transport', () => {
    // Same board as the LOAD test above: confirming makes the unit cargo, so
    // there is no next-turn firing position to show.
    const state = makeState({
      width: 6,
      height: 1,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 0 } },
      ],
      tiles: [{ pos: { x: 3, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'transport', owner: 0, pos: { x: 3, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 5, y: 0 } },
      ],
    });
    const h = mount(state);
    h.tap({ x: 1, y: 0 });
    h.tap({ x: 3, y: 0 });
    expect(h.input.getState().kind).toBe('move-previewed');
    const ov = h.input.getOverlay();
    expect(ov.attackRange).toBeUndefined();
    expect(ov.attackRangeBorder).toBeUndefined();
  });
});

// ─── Debounce ──────────────────────────────────────────────────────────────

describe('mobile grammar — 150ms debounce on the confirming tap', () => {
  it('drops a confirming tap that arrives too soon, then honours the next one', () => {
    const h = mount(skirmish());
    const enemy = h.unit(1).id;
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 3, y: 1 });
    expect(h.input.getState().kind).toBe('attack-staged');

    // Same instant: a double-tap, not a decision.
    h.tap({ x: 3, y: 1 });
    expect(h.actions).toEqual([]);
    expect(h.input.getState().kind).toBe('attack-staged');

    // 149ms: still inside the window.
    h.wait(149);
    h.tap({ x: 3, y: 1 });
    expect(h.actions).toEqual([]);
    expect(h.input.getState().kind).toBe('attack-staged');
    expect(h.emitter.getState().units[enemy]!.hp).toBe(100);

    // 150ms: through.
    h.wait(1);
    h.tap({ x: 3, y: 1 });
    expect(h.actions).toEqual(['MOVE', 'ATTACK']);
    expect(h.emitter.getState().units[enemy]!.hp).toBeLessThan(100);
  });

  it('confirmStaged() is an explicit press and skips the debounce entirely', () => {
    const h = mount(skirmish());
    const enemy = h.unit(1).id;
    h.tap({ x: 1, y: 1 });
    h.tap({ x: 3, y: 1 });
    h.input.confirmStaged(); // no clock advance at all
    expect(h.actions).toEqual(['MOVE', 'ATTACK']);
    expect(h.emitter.getState().units[enemy]!.hp).toBeLessThan(100);
    expect(h.input.getState().kind).toBe('idle');
  });

  it('confirmStaged() commits a staged move the same way a third tap would', () => {
    const h = mount(skirmish());
    h.tap({ x: 1, y: 1 });
    // (1,2): out of the enemy's reach, so the commit is the plain MOVE + WAIT
    // (a destination with options left would open the orders menu instead).
    h.tap({ x: 1, y: 2 });
    h.input.confirmStaged();
    expect(h.actions).toEqual(['MOVE', 'WAIT']);
  });
});

// ─── Build: stage then confirm ─────────────────────────────────────────────

describe('mobile grammar — build stage-then-confirm', () => {
  function factoryBoard(): GameState {
    const state = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 2 } },
      ],
      tiles: [{ pos: { x: 2, y: 0 }, terrain: 'factory', owner: 0 }],
      units: [],
    });
    state.players[0].funds = 99_999;
    return state;
  }

  it('stageBuild marks the entry without spending anything', () => {
    const h = mount(factoryBoard());
    h.tap({ x: 2, y: 0 });
    h.input.stageBuild('tank');
    const s = h.input.getState();
    expect(s.kind).toBe('build-menu-open');
    if (s.kind === 'build-menu-open') expect(s.staged).toBe('tank');
    expect(h.actions).toEqual([]);
    expect(h.emitter.getState().players[0].funds).toBe(99_999);
  });

  it('confirmStaged turns the staged entry into a BUILD', () => {
    const h = mount(factoryBoard());
    h.tap({ x: 2, y: 0 });
    h.input.stageBuild('infantry');
    h.input.confirmStaged();
    expect(h.actions).toEqual(['BUILD']);
    expect(h.input.getState().kind).toBe('idle');
    const built = Object.values(h.emitter.getState().units).find(
      (u) => u.pos.x === 2 && u.pos.y === 0,
    );
    expect(built?.type).toBe('infantry');
  });

  it('confirmStaged with nothing staged does nothing', () => {
    const h = mount(factoryBoard());
    h.tap({ x: 2, y: 0 });
    h.input.confirmStaged();
    expect(h.actions).toEqual([]);
    expect(h.input.getState().kind).toBe('build-menu-open');
  });

  it('stageBuild ignores an unaffordable entry', () => {
    const state = factoryBoard();
    state.players[0].funds = 0;
    const h = mount(state);
    h.tap({ x: 2, y: 0 });
    h.input.stageBuild('tank');
    const s = h.input.getState();
    expect(s.kind === 'build-menu-open' && s.staged).toBeUndefined();
  });
});

// ─── Desktop invariant ─────────────────────────────────────────────────────

describe('desktop grammar is untouched by any of this', () => {
  it('still commits the MOVE on the second click and opens the action menu', () => {
    const h = mount(skirmish(), { grammar: 'desktop' });
    h.tap({ x: 1, y: 1 });
    expect(h.input.getState().kind).toBe('unit-selected');
    h.tap({ x: 2, y: 1 });
    const staged = h.input.getState();
    expect(staged.kind).toBe('move-previewed');
    // No debounce bookkeeping under the desktop grammar.
    if (staged.kind === 'move-previewed') expect(staged.stagedAt).toBeUndefined();
    h.tap({ x: 2, y: 1 });
    // MOVE only — no implicit WAIT; the action menu decides what's next.
    expect(h.actions).toEqual(['MOVE']);
    expect(h.input.getState().kind).toBe('action-menu');
  });

  it('never produces a mobile-only node', () => {
    const h = mount(skirmish(), { grammar: 'desktop' });
    h.tap({ x: 3, y: 1 }); // an enemy: desktop ignores it from idle
    expect(h.input.getState().kind).toBe('idle');
    h.tap({ x: 4, y: 0 }); // bare terrain
    expect(h.input.getState().kind).toBe('idle');
    expect(h.actions).toEqual([]);
  });

  it('the mobile-only methods are inert outside their states', () => {
    const h = mount(skirmish(), { grammar: 'desktop' });
    h.input.confirmStaged();
    h.input.stageBuild('infantry');
    h.input.toggleThreat();
    expect(h.input.getState().kind).toBe('idle');
    expect(h.actions).toEqual([]);
  });
});
