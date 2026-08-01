// @vitest-environment jsdom
//
// Mobile command tray (src/renderer/mobile/tray.ts).
//
// The tray is a pure projection of `input.getState() × emitter.getState()`, so
// the whole suite is shaped the same way: park the stub input controller on a
// node, read the DOM, click a button, assert the call came back through the
// controller. That covers the three things a regression would actually break:
//
//   1. every input node renders SOMETHING, with the data hooks e2e depends on
//      (`data-tray-state`, `data-tray-hint`, `data-action="end-turn"`,
//      `data-menu-entry`, `data-build-entry`);
//   2. confirm / cancel / stage / threat wire back to the input controller
//      rather than reaching into the engine;
//   3. the campaign extension points override the state-driven rendering and
//      restore it cleanly on `null`.

import { describe, expect, it, beforeEach } from 'vitest';
import { createEmitter } from '../src/renderer/emitter';
import { createTray } from '../src/renderer/mobile/tray';
import type { Tray } from '../src/renderer/mobile/tray';
import type { AIDriver } from '../src/renderer/ai-driver';
import type { AnimationQueue } from '../src/renderer/animations';
import type { AudioModule } from '../src/renderer/audio';
import type { Emitter } from '../src/renderer/emitter';
import type { InputController, InputState } from '../src/renderer/input';
import type { SpriteCache } from '../src/renderer/sprites';
import type { Action, GameState, Unit, UnitType } from '../src/engine/core/types';
import { makeState } from './test-helpers';

// ─────────────────────────── Stubs ───────────────────────────────────────────

type Calls = {
  confirm: number;
  cancel: number;
  threat: number;
  builds: UnitType[];
  actions: string[];
};

type InputStub = {
  input: InputController;
  calls: Calls;
  /** Park the machine on a node and fire the same signal input.ts fires. */
  set(next: InputState): void;
};

function makeInputStub(emitter: Emitter): InputStub {
  let state: InputState = { kind: 'idle' };
  const calls: Calls = { confirm: 0, cancel: 0, threat: 0, builds: [], actions: [] };
  const input = {
    getState: () => state,
    confirmStaged: () => {
      calls.confirm += 1;
    },
    cancel: () => {
      calls.cancel += 1;
    },
    toggleThreat: () => {
      calls.threat += 1;
    },
    stageBuild: (t: UnitType) => calls.builds.push(t),
    chooseAction: (l: string) => calls.actions.push(l),
  } as unknown as InputController;
  return {
    input,
    calls,
    set(next: InputState): void {
      state = next;
      emitter.emit({ type: 'inputStateChanged', kind: next.kind });
    },
  };
}

type AISet = { pid: number; choice: string };

function stubAIDriver(locked = false, sets: AISet[] = []): AIDriver {
  return {
    getPlayerAI: () => 'human',
    setPlayerAI: (pid: number, choice: string) => sets.push({ pid, choice }),
    inputLocked: () => locked,
    tick: () => {},
    busy: () => false,
  } as unknown as AIDriver;
}

function stubAnimQueue(): AnimationQueue {
  return { busy: () => false } as unknown as AnimationQueue;
}

function stubAudio(): AudioModule {
  let muted = true;
  return {
    isMuted: () => muted,
    setMuted: (m: boolean) => {
      muted = m;
    },
    unlock: () => {},
    onAction: () => {},
  } as unknown as AudioModule;
}

/** No data URLs → the letter-chip fallback, which keeps the card shape without
 *  needing a canvas backend. */
function stubSprites(): SpriteCache {
  return { toDataURL: () => null } as unknown as SpriteCache;
}

// ─────────────────────────── Scenario ────────────────────────────────────────

/**
 * 6×6 board: P0 infantry at (2,2), P1 tank adjacent at (3,2), a P0 factory
 * under the infantry's feet is NOT needed — the build node is driven directly
 * through the stubbed input state.
 */
function scenario(): GameState {
  return makeState({
    width: 6,
    height: 6,
    hqs: [
      { owner: 0, pos: { x: 0, y: 0 } },
      { owner: 1, pos: { x: 5, y: 5 } },
    ],
    units: [
      { type: 'infantry', owner: 0, pos: { x: 2, y: 2 } },
      { type: 'tank', owner: 1, pos: { x: 3, y: 2 } },
    ],
  });
}

function unitOf(state: GameState, owner: 0 | 1): Unit {
  return Object.values(state.units).find((u) => u.owner === owner)!;
}

type Mounted = {
  emitter: Emitter;
  stub: InputStub;
  tray: Tray;
  insets: number[];
  dispatched: Action[];
  aiSets: AISet[];
};

function mount(opts: { locked?: boolean; state?: GameState } = {}): Mounted {
  document.body.innerHTML = '<div id="app"></div>';
  const emitter = createEmitter(opts.state ?? scenario());
  const dispatched: Action[] = [];
  emitter.on((ev) => {
    if (ev.type === 'stateChanged' && ev.action !== null) dispatched.push(ev.action);
  });
  const stub = makeInputStub(emitter);
  const insets: number[] = [];
  const aiSets: AISet[] = [];
  const tray = createTray({
    parent: document.getElementById('app')!,
    emitter,
    input: stub.input,
    aiDriver: stubAIDriver(opts.locked ?? false, aiSets),
    animQueue: stubAnimQueue(),
    audio: stubAudio(),
    sprites: stubSprites(),
    onInsetsChange: (b) => insets.push(b),
  });
  return { emitter, stub, tray, insets, dispatched, aiSets };
}

function q<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}

function trayState(): string {
  return q('.tray').dataset.trayState ?? '';
}

function hintText(): string {
  return q('[data-tray-hint]').textContent ?? '';
}

// ─────────────────────────── Tests ───────────────────────────────────────────

describe('tray — state rendering', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('idle: placeholder, tools, end turn — and a hint', () => {
    mount();
    expect(trayState()).toBe('idle');
    expect(document.querySelector('.tray-placeholder')).not.toBeNull();
    expect(document.querySelector('[data-tray-tools]')).not.toBeNull();
    expect(document.querySelector('[data-action="end-turn"]')).not.toBeNull();
    expect(hintText()).toBe('Tap a unit to command');
  });

  it('unit-selected: a unit card with name + stat chips', () => {
    const { emitter, stub } = mount();
    const unit = unitOf(emitter.getState(), 0);
    stub.set({ kind: 'unit-selected', unit, reachable: [] });

    expect(trayState()).toBe('unit-selected');
    const card = q('.tray-card');
    expect(card.classList.contains('tray-card-own')).toBe(true);
    expect(q('.tray-name').textContent).toBe('INFANTRY');
    const chips = Array.from(document.querySelectorAll('.tray-chip')).map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(['MOVE 3', 'RNG 1', 'HP 100']);
    expect(hintText()).toContain('highlighted tile');
    // End Turn stays reachable while a unit is merely selected.
    expect(document.querySelector('[data-action="end-turn"]')).not.toBeNull();
  });

  it('move-previewed: destination terrain card + cancel/confirm', () => {
    const { emitter, stub } = mount();
    const unit = unitOf(emitter.getState(), 0);
    stub.set({
      kind: 'move-previewed',
      unit,
      reachable: [],
      destination: { x: 2, y: 4 },
      path: [
        { x: 2, y: 3 },
        { x: 2, y: 4 },
      ],
      stagedAt: 0,
    });

    expect(trayState()).toBe('move-previewed');
    expect(q('.tray-card').classList.contains('tray-card-terrain')).toBe(true);
    expect(q('.tray-name').textContent).toBe('PLAIN · destination');
    const chips = Array.from(document.querySelectorAll('.tray-chip')).map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(['DEF ★☆☆☆', '2 TILES']);
    expect(q('[data-tray-confirm]').textContent).toBe('CONFIRM MOVE');
    expect(hintText()).toContain('confirm the move');
    // Armed unit staged onto an empty tile: the hint names the radar the board
    // is painting.
    expect(hintText()).toContain('strike next turn');
  });

  it('capture-staged: property card + CONFIRM CAPTURE', () => {
    const state = scenario();
    state.map[2]![4]! = { terrain: 'city', owner: null };
    const { emitter, stub } = mount({ state });
    const unit = unitOf(emitter.getState(), 0);
    stub.set({
      kind: 'capture-staged',
      unit,
      reachable: [],
      destination: { x: 4, y: 2 },
      path: [{ x: 4, y: 2 }],
      stagedAt: 0,
    });

    expect(trayState()).toBe('capture-staged');
    expect(q('.tray-name').textContent).toBe('CITY · capture');
    expect(q('[data-tray-confirm]').textContent).toBe('CONFIRM CAPTURE');
    // Capturable tiles advertise their owner + income.
    const chips = Array.from(document.querySelectorAll('.tray-chip')).map(
      (c) => c.textContent,
    );
    expect(chips).toContain('NEUTRAL');
    expect(chips).toContain('+ $1,000');
  });

  it('attack-staged: both sprites, forecast numbers, HP bars', () => {
    const { emitter, stub } = mount();
    const attacker = unitOf(emitter.getState(), 0);
    const target = unitOf(emitter.getState(), 1);
    stub.set({
      kind: 'attack-staged',
      unit: attacker,
      reachable: [],
      target,
      firingPos: attacker.pos,
      path: [],
      stagedAt: 0,
    });

    expect(trayState()).toBe('attack-staged');
    const fighters = document.querySelectorAll('.tray-fighter');
    expect(fighters).toHaveLength(2);
    expect(document.querySelectorAll('.tray-sprite')).toHaveLength(2);
    expect(document.querySelectorAll('.tray-hpbar')).toHaveLength(2);

    const dmg = q('[data-tray-damage]');
    expect(Number(dmg.dataset.trayDamage)).toBeGreaterThan(0);
    const counter = q('[data-tray-counter]');
    expect(Number(counter.dataset.trayCounter)).toBeGreaterThan(0);
    expect(q('[data-tray-confirm]').textContent).toBe('CONFIRM ATTACK');
    expect(hintText()).toContain('Fires from where it stands');
  });

  it('action-menu: orders render as [data-menu-entry] and route to chooseAction', () => {
    const { emitter, stub } = mount();
    const unit = unitOf(emitter.getState(), 0);
    stub.set({
      kind: 'action-menu',
      unit,
      anchor: unit.pos,
      entries: [
        { label: 'Attack', enabled: true },
        { label: 'Wait', enabled: false },
      ],
    });

    expect(trayState()).toBe('action-menu');
    const entries = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-menu-entry]'),
    );
    expect(entries.map((e) => e.dataset.menuEntry)).toEqual(['Attack', 'Wait']);
    expect(entries[1]!.disabled).toBe(true);

    entries[0]!.click();
    expect(stub.calls.actions).toEqual(['Attack']);
  });

  it('enemy-inspect: blue card, threat toggle, dismiss', () => {
    const { emitter, stub } = mount();
    const enemy = unitOf(emitter.getState(), 1);
    stub.set({ kind: 'enemy-inspect', unit: enemy, showThreat: false });

    expect(trayState()).toBe('enemy-inspect');
    expect(q('.tray-card').classList.contains('tray-card-enemy')).toBe(true);
    expect(q('.tray-name').textContent).toBe('COBALT TANK · enemy');

    const threat = q('[data-tray-threat]');
    expect(threat.textContent).toBe('SHOW THREAT RANGE');
    threat.click();
    expect(stub.calls.threat).toBe(1);

    // The label follows the node, not the click.
    stub.set({ kind: 'enemy-inspect', unit: enemy, showThreat: true });
    expect(q('[data-tray-threat]').textContent).toBe('HIDE THREAT RANGE');

    q('[data-tray-cancel]').click();
    expect(stub.calls.cancel).toBe(1);
  });

  it('tile-inspect: terrain card with defense stars and property info', () => {
    const state = scenario();
    state.map[1]![3]! = { terrain: 'forest', owner: null };
    const { stub } = mount({ state });
    stub.set({ kind: 'tile-inspect', tile: { x: 3, y: 1 } });

    expect(trayState()).toBe('tile-inspect');
    expect(q('.tray-name').textContent).toBe('FOREST');
    expect(q('[data-tray-stars]').dataset.trayStars).toBe('2');
    expect(q('[data-tray-stars]').textContent).toBe('★★☆☆');
    expect(hintText()).toContain('defense');
  });

  it('targeting nodes still render a hint and an escape hatch', () => {
    const { emitter, stub } = mount();
    const unit = unitOf(emitter.getState(), 0);
    stub.set({ kind: 'attack-targeting', unit, targets: [], hover: null });
    expect(trayState()).toBe('attack-targeting');
    expect(hintText()).not.toBe('');
    q('[data-tray-cancel]').click();
    expect(stub.calls.cancel).toBe(1);
  });

  it('every input node renders a [data-tray-hint] element', () => {
    const { emitter, stub } = mount();
    const own = unitOf(emitter.getState(), 0);
    const foe = unitOf(emitter.getState(), 1);
    const nodes: InputState[] = [
      { kind: 'idle' },
      { kind: 'unit-selected', unit: own, reachable: [] },
      {
        kind: 'move-previewed',
        unit: own,
        reachable: [],
        destination: { x: 2, y: 3 },
        path: [{ x: 2, y: 3 }],
        stagedAt: 0,
      },
      { kind: 'action-menu', unit: own, anchor: own.pos, entries: [] },
      { kind: 'attack-targeting', unit: own, targets: [], hover: null },
      { kind: 'unload-targeting', transport: own, cargo: own, destinations: [] },
      { kind: 'build-menu-open', tile: { x: 0, y: 0 }, entries: [] },
      { kind: 'enemy-inspect', unit: foe, showThreat: false },
      { kind: 'tile-inspect', tile: { x: 1, y: 1 } },
      {
        kind: 'attack-staged',
        unit: own,
        reachable: [],
        target: foe,
        firingPos: own.pos,
        path: [],
        stagedAt: 0,
      },
      {
        kind: 'capture-staged',
        unit: own,
        reachable: [],
        destination: { x: 0, y: 0 },
        path: [],
        stagedAt: 0,
      },
    ];
    for (const node of nodes) {
      stub.set(node);
      expect(trayState(), `data-tray-state for ${node.kind}`).toBe(node.kind);
      expect(
        document.querySelectorAll('[data-tray-hint]'),
        `hint for ${node.kind}`,
      ).toHaveLength(1);
    }
  });
});

describe('tray — confirm / cancel call-through', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('CONFIRM calls input.confirmStaged and CANCEL calls input.cancel', () => {
    const { emitter, stub } = mount();
    const unit = unitOf(emitter.getState(), 0);
    stub.set({
      kind: 'move-previewed',
      unit,
      reachable: [],
      destination: { x: 2, y: 3 },
      path: [{ x: 2, y: 3 }],
      stagedAt: 0,
    });
    q('[data-tray-confirm]').click();
    expect(stub.calls.confirm).toBe(1);
    q('[data-tray-cancel]').click();
    expect(stub.calls.cancel).toBe(1);
  });

  it('End Turn dispatches END_TURN after dropping the selection', () => {
    const { dispatched, stub } = mount();
    q<HTMLButtonElement>('[data-action="end-turn"]').click();
    expect(stub.calls.cancel).toBe(1);
    expect(dispatched.map((a) => a.type)).toEqual(['END_TURN']);
  });

  it('End Turn is disabled (and inert) while the AI holds the turn', () => {
    const { dispatched } = mount({ locked: true });
    const btn = q<HTMLButtonElement>('[data-action="end-turn"]');
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(dispatched).toEqual([]);
  });

  it('End Turn is disabled once the match is over', () => {
    const state = scenario();
    state.winner = 0;
    mount({ state });
    // The winner takeover replaces the state body; End Turn is gone entirely.
    expect(trayState()).toBe('winner');
    expect(document.querySelector('[data-action="end-turn"]')).toBeNull();
    expect(document.querySelector('[data-action="play-again"]')).not.toBeNull();
    expect(q('.tray-comp-title').textContent).toBe('Vermilion victorious');
  });
});

describe('tray — build staging', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function openBuild(staged?: UnitType): Mounted {
    const state = scenario();
    state.map[3]![1]! = { terrain: 'factory', owner: 0 };
    state.players[0].funds = 5000;
    const m = mount({ state });
    m.stub.set({
      kind: 'build-menu-open',
      tile: { x: 1, y: 3 },
      entries: [
        { unitType: 'infantry', label: 'Infantry', cost: 1000, affordable: true },
        { unitType: 'recon', label: 'Recon', cost: 4000, affordable: true },
        { unitType: 'tank', label: 'Tank', cost: 7000, affordable: false },
      ],
      ...(staged !== undefined ? { staged } : {}),
    });
    return m;
  }

  it('renders [data-build-entry] rows with prices; unaffordable rows are disabled', () => {
    openBuild();
    expect(trayState()).toBe('build-menu-open');
    expect(q('.tray-build-title').textContent).toBe('FACTORY');
    expect(q('.tray-build-funds').textContent).toBe('◈ $5,000');

    const rows = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-build-entry]'),
    );
    expect(rows.map((r) => r.dataset.buildEntry)).toEqual([
      'infantry',
      'recon',
      'tank',
    ]);
    expect(rows.map((r) => r.disabled)).toEqual([false, false, true]);
    expect(rows[1]!.querySelector('.tray-bprice')!.textContent).toBe('$4,000');
  });

  it('first tap stages, and the staged row is highlighted', () => {
    const m = openBuild();
    q<HTMLButtonElement>('[data-build-entry="recon"]').click();
    expect(m.stub.calls.builds).toEqual(['recon']);
    expect(m.stub.calls.confirm).toBe(0);

    // The input controller would come back with `staged` set; simulate that.
    m.stub.set({
      kind: 'build-menu-open',
      tile: { x: 1, y: 3 },
      entries: [
        { unitType: 'recon', label: 'Recon', cost: 4000, affordable: true },
      ],
      staged: 'recon',
    });
    const row = q<HTMLButtonElement>('[data-build-entry="recon"]');
    expect(row.classList.contains('staged')).toBe(true);
    expect(row.getAttribute('aria-pressed')).toBe('true');
  });

  it('tapping the staged row again confirms, as does the BUILD button', () => {
    const m = openBuild('recon');
    expect(document.querySelector('[data-tray-confirm]')).not.toBeNull();

    q<HTMLButtonElement>('[data-build-entry="recon"]').click();
    expect(m.stub.calls.confirm).toBe(1);
    expect(m.stub.calls.builds).toEqual([]);

    q('[data-tray-confirm]').click();
    expect(m.stub.calls.confirm).toBe(2);
  });

  it('BUILD only appears once something is staged; CLOSE always cancels', () => {
    const m = openBuild();
    expect(document.querySelector('[data-tray-confirm]')).toBeNull();
    const close = q('[data-tray-cancel]');
    expect(close.textContent).toBe('CLOSE');
    close.click();
    expect(m.stub.calls.cancel).toBe(1);
  });
});

describe('tray — campaign extension points', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('setObjective shows and clears the objective line', () => {
    const { tray } = mount();
    const el = q('[data-tray-objective]');
    expect(el.hidden).toBe(true);

    tray.setObjective('Capture the Cobalt HQ');
    expect(q('[data-tray-objective]').hidden).toBe(false);
    expect(q('[data-tray-objective]').textContent).toBe('Capture the Cobalt HQ');

    tray.setObjective(null);
    expect(q('[data-tray-objective]').hidden).toBe(true);
  });

  it('setHint overrides the state hint and restores it on null', () => {
    const { tray, emitter, stub } = mount();
    const stateHint = hintText();
    expect(stateHint).toBe('Tap a unit to command');

    tray.setHint('Move onto the city to claim it');
    expect(hintText()).toBe('Move onto the city to claim it');

    // The override survives a state transition…
    stub.set({ kind: 'unit-selected', unit: unitOf(emitter.getState(), 0), reachable: [] });
    expect(hintText()).toBe('Move onto the city to claim it');

    // …and clearing it hands the node's own hint back.
    tray.setHint(null);
    expect(hintText()).toContain('highlighted tile');
  });

  it('presentPanel replaces the body and restores the state view on null', () => {
    const { tray } = mount();
    const panel = document.createElement('div');
    panel.id = 'mission-debrief';
    panel.textContent = 'Mission 1 complete';

    tray.presentPanel(panel);
    expect(trayState()).toBe('panel');
    expect(document.querySelector('#mission-debrief')).not.toBeNull();
    // The state body is gone while a panel is presented.
    expect(document.querySelector('.tray-placeholder')).toBeNull();
    expect(document.querySelector('[data-action="end-turn"]')).toBeNull();
    // …but the hint element survives, so setHint still narrates.
    expect(document.querySelectorAll('[data-tray-hint]')).toHaveLength(1);

    tray.presentPanel(null);
    expect(trayState()).toBe('idle');
    expect(document.querySelector('#mission-debrief')).toBeNull();
    expect(document.querySelector('.tray-placeholder')).not.toBeNull();
  });
});

describe('tray — tools sheet + lifecycle', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('☰ opens Save / Load / Sound / Restart / Campaign, and CLOSE returns to the state', () => {
    mount();
    q('[data-tray-tools]').click();
    expect(q('.tray').dataset.traySheet).toBe('tools');
    const tools = Array.from(document.querySelectorAll('[data-tray-tool]')).map(
      (t) => (t as HTMLElement).dataset.trayTool,
    );
    expect(tools).toEqual(['save', 'load', 'sound', 'restart', 'campaign', 'close']);
    // Replay / fog toggle stay desktop-only.
    expect(document.querySelector('[data-tray-tool="replay"]')).toBeNull();

    q('[data-tray-tool="sound"]').click();
    expect(q('[data-tray-tool="sound"]').textContent).toBe('SOUND ON');

    q('[data-tray-tool="close"]').click();
    expect(q('.tray').dataset.traySheet).toBeUndefined();
    expect(document.querySelector('.tray-placeholder')).not.toBeNull();
  });

  it('tools sheet: map picker + per-seat controllers (who you play against)', () => {
    const { aiSets } = mount();
    q('[data-tray-tools]').click();

    // Map picker: every skirmish board, the loaded one selected (no ?map= in
    // the jsdom URL → duel, the default).
    const mapSel = q<HTMLSelectElement>('[data-tray-map]');
    expect(Array.from(mapSel.options).map((o) => o.value)).toEqual([
      'duel',
      'crossroads',
      'island_hop',
      'canyon',
      'highlands',
      'armada',
    ]);
    expect(mapSel.value).toBe('duel');

    // Controller pickers: one per seat, seeded from the driver, and a change
    // goes straight back through it — no reload, same as desktop's strip.
    const p0 = q<HTMLSelectElement>('[data-tray-ai="0"]');
    const p1 = q<HTMLSelectElement>('[data-tray-ai="1"]');
    expect(p0.value).toBe('human');
    expect(Array.from(p1.options).map((o) => o.value)).toEqual([
      'human',
      'random',
      'utility',
      'aggressor',
      'turtle',
      'economist',
      'balanced',
    ]);
    p1.value = 'balanced';
    p1.dispatchEvent(new Event('change'));
    expect(aiSets).toEqual([{ pid: 1, choice: 'balanced' }]);
  });

  it('an input transition closes the tools sheet', () => {
    const { emitter, stub } = mount();
    q('[data-tray-tools]').click();
    expect(q('.tray').dataset.traySheet).toBe('tools');
    stub.set({ kind: 'unit-selected', unit: unitOf(emitter.getState(), 0), reachable: [] });
    expect(q('.tray').dataset.traySheet).toBeUndefined();
  });

  it('reports its measured height on mount', () => {
    const { insets } = mount();
    // jsdom does no layout, so this asserts the callback contract fires — the
    // real pixel value comes from the ResizeObserver in a browser.
    expect(insets.length).toBeGreaterThanOrEqual(1);
    expect(insets[0]).toBe(0);
  });

  it('only the idle baseline height reaches the board inset (overlay contract)', () => {
    const { insets, stub, emitter } = mount();
    // jsdom does no layout — drive the measurement by hand so the baseline
    // gate, not the same-value no-op guard, is what these assertions exercise.
    let height = 120;
    Object.defineProperty(q('.tray'), 'offsetHeight', { get: () => height });

    stub.set({ kind: 'idle' });
    expect(insets.at(-1)).toBe(120);
    const reported = insets.length;

    // A taller transient state must NOT re-band the board — it overlays it.
    height = 260;
    stub.set({
      kind: 'unit-selected',
      unit: unitOf(emitter.getState(), 0),
      reachable: [],
    });
    expect(insets.length).toBe(reported);
    expect(insets.at(-1)).toBe(120);

    // The tools sheet is a transient too, even though the node stays idle.
    // (Heights flip alongside the transitions the same way a browser re-layout
    // would — render() rebuilds the DOM synchronously before measuring.)
    height = 120;
    stub.set({ kind: 'idle' });
    q('[data-tray-tools]').click();
    height = 300;
    stub.set({ kind: 'idle' });
    expect(insets.at(-1)).toBe(120);

    // Back to a settled idle tray: the baseline re-reports. (The height flips
    // before the click because render() rebuilds the idle DOM synchronously —
    // the browser measurement always sees the settled layout.)
    height = 132;
    q('[data-tray-tool="close"]').click();
    expect(insets.at(-1)).toBe(132);
  });

  it('destroy() removes the tray and stops re-rendering', () => {
    const { tray, emitter, stub } = mount();
    expect(document.querySelector('.tray')).not.toBeNull();
    tray.destroy();
    expect(document.querySelector('.tray')).toBeNull();
    // No throw on a post-destroy signal.
    stub.set({ kind: 'unit-selected', unit: unitOf(emitter.getState(), 0), reachable: [] });
  });
});
