// Reducer purity: idempotency, no-mutation, unknown-action handling.

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';
import type { Action } from '../src/engine/core/types';

describe('reducer purity', () => {
  it('idempotent: reducing the same action twice produces equal outputs (deep equal)', () => {
    const s = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const id = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const action: Action = {
      type: 'MOVE',
      unitId: id,
      path: [{ x: 1, y: 0 }, { x: 2, y: 0 }],
    };
    const a = reduce(s, action);
    const b = reduce(s, action);
    // a and b are independent objects but structurally equal.
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('does not mutate input state when applying ATTACK (deep-equal snapshot)', () => {
    const s = makeState({
      width: 3,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        { type: 'tank', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'tank', owner: 1, pos: { x: 1, y: 0 } },
      ],
    });
    const snapshot = structuredClone(s);
    const a = Object.values(s.units).find((u) => u.owner === 0)!;
    const t = Object.values(s.units).find((u) => u.owner === 1)!;
    const after = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: t.id });
    // Original untouched.
    expect(s).toEqual(snapshot);
    // After definitely changed.
    expect(after.units[t.id]!.hp).toBeLessThan(100);
  });

  it('does not mutate input state when applying CAPTURE', () => {
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
    const snap = structuredClone(s);
    const inf = Object.values(s.units).find((u) => u.owner === 0)!;
    reduce(s, { type: 'CAPTURE', unitId: inf.id });
    expect(s).toEqual(snap);
  });

  it('does not mutate input state when applying BUILD', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'factory', owner: 0 }],
      units: [{ type: 'infantry', owner: 1, pos: { x: 2, y: 0 } }],
      funds: { 0: 5000 },
    });
    const snap = structuredClone(s);
    reduce(s, {
      type: 'BUILD',
      at: { x: 1, y: 0 },
      unitType: 'infantry',
      owner: 0,
    });
    expect(s).toEqual(snap);
  });

  it('does not mutate input state when applying END_TURN', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: 0 }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const snap = structuredClone(s);
    reduce(s, { type: 'END_TURN' });
    expect(s).toEqual(snap);
  });

  it('does not mutate input state when applying WAIT', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const snap = structuredClone(s);
    const id = Object.values(s.units).find((u) => u.owner === 0)!.id;
    reduce(s, { type: 'WAIT', unitId: id });
    expect(s).toEqual(snap);
  });

  it('unknown action type is a graceful no-op (does not throw)', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const bogus = { type: 'NOPE' } as unknown as Action;
    expect(() => reduce(s, bogus)).not.toThrow();
    expect(reduce(s, bogus)).toBe(s);
  });

  it('illegal action returns the SAME state reference (PLAN.md convention)', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    // MOVE empty path is illegal.
    const id = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const r = reduce(s, { type: 'MOVE', unitId: id, path: [] });
    expect(r).toBe(s);
  });
});
