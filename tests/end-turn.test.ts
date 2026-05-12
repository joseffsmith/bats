// END_TURN: player swap, income, flag reset, turn counter, build lock-out.

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';

describe('END_TURN: swap and counter', () => {
  it('swaps currentPlayer 0 → 1 → 0 across two END_TURNs', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    expect(s.currentPlayer).toBe(0);
    const t1 = reduce(s, { type: 'END_TURN' });
    expect(t1.currentPlayer).toBe(1);
    const t2 = reduce(t1, { type: 'END_TURN' });
    expect(t2.currentPlayer).toBe(0);
  });

  it('increments turn counter by 1 per END_TURN', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    expect(s.turn).toBe(1);
    const t1 = reduce(s, { type: 'END_TURN' });
    expect(t1.turn).toBe(2);
    const t2 = reduce(t1, { type: 'END_TURN' });
    expect(t2.turn).toBe(3);
    const t3 = reduce(t2, { type: 'END_TURN' });
    expect(t3.turn).toBe(4);
  });
});

describe('END_TURN: income', () => {
  it('income = (HQ + cities + factories) × 1000 added to ending-player funds', () => {
    const s = makeState({
      width: 6,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 0 } },
      ],
      tiles: [
        { pos: { x: 1, y: 0 }, terrain: 'city', owner: 0 },
        { pos: { x: 2, y: 0 }, terrain: 'city', owner: 0 },
        { pos: { x: 3, y: 0 }, terrain: 'factory', owner: 0 },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 5, y: 0 } },
      ],
    });
    // P0 starts at funds=0. HQ + 2 cities + 1 factory = 4 × 1000 = 4000.
    expect(s.players[0]!.funds).toBe(0);
    const next = reduce(s, { type: 'END_TURN' });
    expect(next.players[0]!.funds).toBe(4000);
    // P1 (still owns its HQ only) should NOT receive income on this END_TURN
    // (the player whose turn just ended gets the income — PLAN.md).
    expect(next.players[1]!.funds).toBe(0);
  });

  it('only the ending player gains income; non-current player funds unchanged', () => {
    const s = makeState({
      width: 6,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 0 } },
      ],
      tiles: [
        { pos: { x: 2, y: 0 }, terrain: 'city', owner: 1 },
        { pos: { x: 3, y: 0 }, terrain: 'factory', owner: 1 },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 5, y: 0 } },
      ],
    });
    let st = reduce(s, { type: 'END_TURN' });
    expect(st.players[0]!.funds).toBe(1000); // P0 ends with HQ only.
    expect(st.players[1]!.funds).toBe(0);
    // Now P1 ends turn — gets HQ + city + factory = 3000.
    st = reduce(st, { type: 'END_TURN' });
    expect(st.players[1]!.funds).toBe(3000);
    expect(st.players[0]!.funds).toBe(1000); // unchanged.
  });
});

describe('END_TURN: flag reset', () => {
  it('all incoming-player units have hasMoved/hasActed reset to false', () => {
    const s = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'tank', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const ids = Object.values(s.units)
      .filter((u) => u.owner === 0)
      .map((u) => u.id);
    // Mark both P0 units as done via WAIT.
    let st = s;
    for (const id of ids) {
      st = reduce(st, { type: 'WAIT', unitId: id });
    }
    for (const id of ids) {
      expect(st.units[id]!.hasMoved).toBe(true);
      expect(st.units[id]!.hasActed).toBe(true);
    }
    // End P0 turn, end P1 turn. Now P0 units should be reset.
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    for (const id of ids) {
      expect(st.units[id]!.hasMoved).toBe(false);
      expect(st.units[id]!.hasActed).toBe(false);
    }
  });

  it('END_TURN does NOT reset flags on the player whose turn just ended', () => {
    const s = makeState({
      width: 4,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 3, y: 0 } },
      ],
    });
    const p0 = Object.values(s.units).find((u) => u.owner === 0)!;
    const after = reduce(s, { type: 'WAIT', unitId: p0.id });
    expect(after.units[p0.id]!.hasMoved).toBe(true);
    const ended = reduce(after, { type: 'END_TURN' });
    // P0's unit is still marked moved on P1's turn.
    expect(ended.units[p0.id]!.hasMoved).toBe(true);
    expect(ended.units[p0.id]!.hasActed).toBe(true);
  });
});

describe('END_TURN: built unit remains locked until next turn', () => {
  it('a unit built this turn cannot act until two END_TURNs later', () => {
    // P0 builds an infantry on its factory. The built unit has hasMoved &
    // hasActed true. On the very next P0 turn (after two END_TURNs) the
    // flags should be reset and the unit can move/attack.
    const s = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'factory', owner: 0 }],
      units: [{ type: 'infantry', owner: 1, pos: { x: 4, y: 0 } }],
      funds: { 0: 2000 },
    });
    let st = reduce(s, {
      type: 'BUILD',
      at: { x: 1, y: 0 },
      unitType: 'infantry',
      owner: 0,
    });
    const built = Object.values(st.units).find(
      (u) => u.owner === 0 && u.pos.x === 1,
    )!;
    expect(built.hasMoved).toBe(true);
    expect(built.hasActed).toBe(true);
    // Try to move it RIGHT NOW — same turn — should be a no-op.
    const sameTurnMove = reduce(st, {
      type: 'MOVE',
      unitId: built.id,
      path: [{ x: 2, y: 0 }],
    });
    expect(sameTurnMove).toBe(st);
    // End P0 → P1 → P0; built unit flags should now be reset.
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    expect(st.units[built.id]!.hasMoved).toBe(false);
    expect(st.units[built.id]!.hasActed).toBe(false);
    const nextTurnMove = reduce(st, {
      type: 'MOVE',
      unitId: built.id,
      path: [{ x: 2, y: 0 }],
    });
    expect(nextTurnMove.units[built.id]!.pos).toEqual({ x: 2, y: 0 });
  });
});

describe('END_TURN: legality', () => {
  it('END_TURN is always legal when no winner is set', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const next = reduce(s, { type: 'END_TURN' });
    expect(next).not.toBe(s);
    expect(next.currentPlayer).toBe(1);
  });
});
