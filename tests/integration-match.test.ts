// Scripted multi-turn integration match. Exercises every system in
// composition: MOVE → ATTACK → counter → kill → CAPTURE → END_TURN →
// income → BUILD → END_TURN, with deterministic, hand-computed final
// values.

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';
import type { GameState } from '../src/engine/core/types';

describe('integration: scripted mini-match', () => {
  function setup(): GameState {
    // 9×3 map. Layout (y rows, x cols):
    //   y=0: road x=0..8
    //   y=1: HQ0 city  road road road road road city  HQ1
    //   y=2: road x=0..8
    //
    //   P0 infantry at (1,1), P0 tank at (1,2).
    //   P1 infantry at (7,1), P1 tank at (7,2).
    return makeState({
      width: 9,
      height: 3,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 8, y: 1 } },
      ],
      tiles: [
        { pos: { x: 2, y: 1 }, terrain: 'city', owner: null },
        { pos: { x: 6, y: 1 }, terrain: 'city', owner: null },
        { pos: { x: 0, y: 0 }, terrain: 'factory', owner: 0 },
        { pos: { x: 8, y: 0 }, terrain: 'factory', owner: 1 },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 1 } },
        { type: 'tank', owner: 0, pos: { x: 1, y: 2 } },
        { type: 'infantry', owner: 1, pos: { x: 7, y: 1 } },
        { type: 'tank', owner: 1, pos: { x: 7, y: 2 } },
      ],
      funds: { 0: 0, 1: 0 },
    });
  }

  it('runs end-to-end and produces hand-computed final state', () => {
    let st = setup();
    const p0Inf = Object.values(st.units).find(
      (u) => u.owner === 0 && u.type === 'infantry',
    )!;
    const p0Tank = Object.values(st.units).find(
      (u) => u.owner === 0 && u.type === 'tank',
    )!;
    const p1Inf = Object.values(st.units).find(
      (u) => u.owner === 1 && u.type === 'infantry',
    )!;
    const p1Tank = Object.values(st.units).find(
      (u) => u.owner === 1 && u.type === 'tank',
    )!;

    // ─────────────── TURN 1 (P0) ───────────────
    // P0 infantry moves onto the city at (2,1) — they will CAPTURE next turn.
    st = reduce(st, {
      type: 'MOVE',
      unitId: p0Inf.id,
      path: [{ x: 2, y: 1 }],
    });
    expect(st.units[p0Inf.id]!.pos).toEqual({ x: 2, y: 1 });
    expect(st.units[p0Inf.id]!.hasMoved).toBe(true);

    // P0 tank advances 6 tiles right along road (y=2). Lands at (7, 2).
    // But (7,2) is occupied by P1 tank. Move to (6, 2) instead — that's a
    // 5-tile path, all road, cost 5 ≤ move 6.
    st = reduce(st, {
      type: 'MOVE',
      unitId: p0Tank.id,
      path: [
        { x: 2, y: 2 },
        { x: 3, y: 2 },
        { x: 4, y: 2 },
        { x: 5, y: 2 },
        { x: 6, y: 2 },
      ],
    });
    expect(st.units[p0Tank.id]!.pos).toEqual({ x: 6, y: 2 });

    // END P0 turn → income: P0 owns HQ + factory = 2 × 1000 = 2000.
    st = reduce(st, { type: 'END_TURN' });
    expect(st.currentPlayer).toBe(1);
    expect(st.players[0]!.funds).toBe(2000);
    expect(st.turn).toBe(2);

    // ─────────────── TURN 1 (P1) ───────────────
    // P1 tank attacks P0 tank: tank vs tank on road (0 stars).
    //   primary damage = floor(55 * 1 * 1) = 55 → P0 tank 45 HP
    //   counter (P0 tank, 45 HP, on road) damage to P1 tank (100 HP, on road):
    //     floor(55 * 0.45 * 1) = floor(24.75) = 24 → P1 tank 76 HP
    st = reduce(st, {
      type: 'ATTACK',
      attackerId: p1Tank.id,
      targetId: p0Tank.id,
    });
    expect(st.units[p0Tank.id]!.hp).toBe(45);
    expect(st.units[p1Tank.id]!.hp).toBe(76);
    expect(st.units[p1Tank.id]!.hasActed).toBe(true);

    // P1 infantry moves onto the (6,1) city for capture next turn.
    // From (7,1), one step left.
    st = reduce(st, {
      type: 'MOVE',
      unitId: p1Inf.id,
      path: [{ x: 6, y: 1 }],
    });
    expect(st.units[p1Inf.id]!.pos).toEqual({ x: 6, y: 1 });

    // END P1 turn → income: HQ + factory = 2000.
    st = reduce(st, { type: 'END_TURN' });
    expect(st.players[1]!.funds).toBe(2000);
    expect(st.currentPlayer).toBe(0);
    expect(st.turn).toBe(3);

    // P0 flags reset.
    expect(st.units[p0Inf.id]!.hasMoved).toBe(false);
    expect(st.units[p0Tank.id]!.hasMoved).toBe(false);

    // ─────────────── TURN 2 (P0) ───────────────
    // P0 infantry CAPTURE city at (2,1): progress += floor(100/10) = 10.
    st = reduce(st, { type: 'CAPTURE', unitId: p0Inf.id });
    expect(st.units[p0Inf.id]!.captureProgress).toBe(10);
    expect(st.map[1]![2]!.owner).toBeNull(); // not yet flipped

    // P0 tank counter-attacks P1 tank.
    //   P0 tank at (6,2) hp 45 → P1 tank at (7,2) hp 76:
    //     primary = floor(55 * 0.45 * 1) = 24 → P1 tank 52 HP
    //   counter: P1 tank (52 HP) → P0 tank (45 HP):
    //     floor(55 * 0.52 * 1) = floor(28.6) = 28 → P0 tank 17 HP
    st = reduce(st, {
      type: 'ATTACK',
      attackerId: p0Tank.id,
      targetId: p1Tank.id,
    });
    expect(st.units[p1Tank.id]!.hp).toBe(52);
    expect(st.units[p0Tank.id]!.hp).toBe(17);

    // P0 BUILDs an infantry at its factory (0,0). Funds 2000 - 1000 = 1000.
    st = reduce(st, {
      type: 'BUILD',
      at: { x: 0, y: 0 },
      unitType: 'infantry',
      owner: 0,
    });
    expect(st.players[0]!.funds).toBe(1000);
    const built = Object.values(st.units).find(
      (u) => u.owner === 0 && u.pos.x === 0 && u.pos.y === 0,
    )!;
    expect(built.hasMoved).toBe(true);
    expect(built.hasActed).toBe(true);

    // END P0 turn → income again: HQ + factory = +2000. funds: 1000 + 2000 = 3000.
    st = reduce(st, { type: 'END_TURN' });
    expect(st.players[0]!.funds).toBe(3000);
    expect(st.turn).toBe(4);
    expect(st.currentPlayer).toBe(1);

    // ─────────────── TURN 2 (P1) ───────────────
    // P1 infantry CAPTUREs (6,1) city: progress 10.
    st = reduce(st, { type: 'CAPTURE', unitId: p1Inf.id });
    expect(st.units[p1Inf.id]!.captureProgress).toBe(10);

    // P1 tank finishes off the wounded P0 tank.
    //   P1 tank (52 HP) → P0 tank (17 HP):
    //     floor(55 * 0.52 * 1) = 28 → would put P0 tank at -11 → 0 (dead)
    st = reduce(st, {
      type: 'ATTACK',
      attackerId: p1Tank.id,
      targetId: p0Tank.id,
    });
    expect(st.units[p0Tank.id]).toBeUndefined(); // killed
    // No counter from a dead unit.
    expect(st.units[p1Tank.id]!.hp).toBe(52);
    // P0 not routed: still has p0Inf + built unit.
    expect(st.winner).toBeNull();

    // END P1 → income.
    st = reduce(st, { type: 'END_TURN' });
    expect(st.players[1]!.funds).toBe(4000); // 2000 + (HQ + factory)
    expect(st.turn).toBe(5);

    // ─────────────── TURN 3 (P0) ───────────────
    // P0 infantry CAPTUREs again — progress hits 20 → flip.
    st = reduce(st, { type: 'CAPTURE', unitId: p0Inf.id });
    expect(st.units[p0Inf.id]!.captureProgress).toBe(0);
    expect(st.map[1]![2]!.owner).toBe(0); // city flipped to P0
    expect(st.map[1]![2]!.terrain).toBe('city');

    // Built infantry can now move (flags reset by END_TURN).
    expect(st.units[built.id]!.hasMoved).toBe(false);
    st = reduce(st, {
      type: 'MOVE',
      unitId: built.id,
      path: [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }],
    });
    expect(st.units[built.id]!.pos).toEqual({ x: 3, y: 0 });

    // ───── Final-state assertions ─────
    // P0 still alive (infantry + built); P1 still alive (infantry + tank).
    const p0Units = Object.values(st.units).filter((u) => u.owner === 0);
    const p1Units = Object.values(st.units).filter((u) => u.owner === 1);
    expect(p0Units.length).toBe(2);
    expect(p1Units.length).toBe(2);

    // Winner not set yet.
    expect(st.winner).toBeNull();
    // P0 funds untouched (no END_TURN this turn): 3000.
    expect(st.players[0]!.funds).toBe(3000);
    // P1 funds: 4000.
    expect(st.players[1]!.funds).toBe(4000);
    // P0 owns city (2,1) and its HQ + factory → 3 income tiles next turn.
    expect(st.map[1]![2]!.owner).toBe(0);
    // P1 owns its HQ + factory only — neutral (6,1) belongs to P1 still in
    // progress (captureProgress 10 on P1's infantry).
    expect(st.units[p1Inf.id]!.captureProgress).toBe(10);
    expect(st.map[1]![6]!.owner).toBeNull();
  });
});
