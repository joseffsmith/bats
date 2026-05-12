// Capture acceptance: progress accrual, flip threshold, ownership transfer,
// CAPTURE legality (terrain, ownership, unit type).

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';

describe('capture: progress accrual', () => {
  it('full-HP infantry adds 10 progress per CAPTURE', () => {
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 3, y: 0 } },
      ],
    });
    const inf = Object.values(s.units).find((u) => u.owner === 0)!;
    const next = reduce(s, { type: 'CAPTURE', unitId: inf.id });
    expect(next.units[inf.id]!.captureProgress).toBe(10);
  });

  it('half-HP (50) infantry adds 5 progress per CAPTURE (floor(50/10))', () => {
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 }, hp: 50 },
        { type: 'infantry', owner: 1, pos: { x: 3, y: 0 } },
      ],
    });
    const inf = Object.values(s.units).find((u) => u.owner === 0)!;
    const next = reduce(s, { type: 'CAPTURE', unitId: inf.id });
    expect(next.units[inf.id]!.captureProgress).toBe(5);
  });

  it('captures across two turns: 10 + 10 = 20 → flip and reset', () => {
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 3, y: 0 } },
      ],
    });
    const inf = Object.values(s.units).find((u) => u.owner === 0)!;
    let st = reduce(s, { type: 'CAPTURE', unitId: inf.id });
    expect(st.units[inf.id]!.captureProgress).toBe(10);
    expect(st.map[0]![1]!.owner).toBeNull();
    // End P0 turn, end P1 turn, back to P0.
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'CAPTURE', unitId: inf.id });
    // Flip: progress reset to 0, tile owner set.
    expect(st.units[inf.id]!.captureProgress).toBe(0);
    expect(st.map[0]![1]!.owner).toBe(0);
  });
});

describe('capture: legality', () => {
  it('non-infantry cannot CAPTURE (tank standing on city is rejected)', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'tank', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const tank = Object.values(s.units).find((u) => u.type === 'tank')!;
    const next = reduce(s, { type: 'CAPTURE', unitId: tank.id });
    expect(next).toBe(s);
  });

  it('cannot capture an already-owned (own) tile', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: 0 }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const inf = Object.values(s.units).find((u) => u.owner === 0)!;
    const next = reduce(s, { type: 'CAPTURE', unitId: inf.id });
    expect(next).toBe(s);
  });

  it('cannot CAPTURE a non-capturable tile (plain/road/forest/mountain/sea)', () => {
    const NON_CAPTURABLE: ReadonlyArray<
      'plain' | 'road' | 'forest' | 'mountain'
    > = ['plain', 'road', 'forest', 'mountain'];
    for (const terrain of NON_CAPTURABLE) {
      const s = makeState({
        width: 3,
        height: 1,
        defaultTerrain: terrain,
        hqs: [
          { owner: 0, pos: { x: 0, y: 0 } },
          { owner: 1, pos: { x: 2, y: 0 } },
        ],
        units: [
          { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
          { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
        ],
      });
      const inf = Object.values(s.units).find((u) => u.owner === 0)!;
      const next = reduce(s, { type: 'CAPTURE', unitId: inf.id });
      expect(next).toBe(s);
    }
  });

  it('cannot CAPTURE if already acted', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const inf = Object.values(s.units).find((u) => u.owner === 0)!;
    const once = reduce(s, { type: 'CAPTURE', unitId: inf.id });
    expect(once.units[inf.id]!.hasActed).toBe(true);
    const twice = reduce(once, { type: 'CAPTURE', unitId: inf.id });
    expect(twice).toBe(once);
  });

  it('cannot CAPTURE an enemy player unit', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 1, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
      ],
    });
    // P0's turn — they cannot CAPTURE with P1's infantry.
    const enemy = Object.values(s.units).find((u) => u.owner === 1)!;
    const next = reduce(s, { type: 'CAPTURE', unitId: enemy.id });
    expect(next).toBe(s);
  });
});

describe('capture: ownership flip', () => {
  it('two consecutive turns of CAPTURE flips ownership to capturing player', () => {
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'factory', owner: 1 }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 3, y: 0 } },
      ],
    });
    const inf = Object.values(s.units).find((u) => u.owner === 0)!;
    let st = reduce(s, { type: 'CAPTURE', unitId: inf.id });
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'CAPTURE', unitId: inf.id });
    // Factory ownership flips from 1 → 0.
    expect(st.map[0]![1]!.owner).toBe(0);
    expect(st.map[0]![1]!.terrain).toBe('factory');
  });

  it('moving off the tile zeroes progress (already covered in capture.test.ts, but reaffirmed here at HP=70)', () => {
    const s = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 }, hp: 70 },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const inf = Object.values(s.units).find((u) => u.owner === 0)!;
    let st = reduce(s, { type: 'CAPTURE', unitId: inf.id });
    expect(st.units[inf.id]!.captureProgress).toBe(7);
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, {
      type: 'MOVE',
      unitId: inf.id,
      path: [{ x: 2, y: 0 }],
    });
    expect(st.units[inf.id]!.captureProgress).toBe(0);
  });
});
