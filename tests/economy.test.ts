import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';
import { computeIncome } from '../src/engine/systems/economy';

describe('economy', () => {
  it('income = (HQ + owned cities + owned factories) × 1000', () => {
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      tiles: [
        { pos: { x: 1, y: 0 }, terrain: 'city', owner: 0 },
        { pos: { x: 2, y: 0 }, terrain: 'factory', owner: 0 },
      ],
    });
    // HQ + city + factory = 3 properties for player 0
    expect(computeIncome(s, 0)).toBe(3000);
    expect(computeIncome(s, 1)).toBe(1000);
  });

  it('END_TURN grants the current player income and swaps the turn', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: 0 }],
    });
    const next = reduce(s, { type: 'END_TURN' });
    expect(next.currentPlayer).toBe(1);
    expect(next.players[0]!.funds).toBe(2000); // HQ + 1 city
    expect(next.turn).toBe(2);
  });

  it('BUILD spawns a unit, deducts funds, and the unit is locked this turn', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'factory', owner: 0 }],
      funds: { 0: 5000 },
    });
    const before = Object.keys(s.units).length;
    const next = reduce(s, {
      type: 'BUILD',
      at: { x: 1, y: 0 },
      unitType: 'infantry',
      owner: 0,
    });
    expect(Object.keys(next.units).length).toBe(before + 1);
    expect(next.players[0]!.funds).toBe(4000);
    const built = Object.values(next.units).find(
      (u) => u.pos.x === 1 && u.pos.y === 0,
    )!;
    expect(built.hasMoved).toBe(true);
    expect(built.hasActed).toBe(true);
  });

  it('BUILD on an occupied factory is rejected', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'factory', owner: 0 }],
      units: [{ type: 'infantry', owner: 0, pos: { x: 1, y: 0 } }],
      funds: { 0: 5000 },
    });
    const next = reduce(s, {
      type: 'BUILD',
      at: { x: 1, y: 0 },
      unitType: 'infantry',
      owner: 0,
    });
    // unchanged
    expect(next.players[0]!.funds).toBe(5000);
  });
});
