// Edge-case coverage: error paths in initial-state, rng determinism,
// selector ergonomics, pathfinding empty-path.

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { createInitialState } from '../src/engine/core/initial-state';
import { createRng, rngInt, rngPick } from '../src/engine/core/rng';
import { validatePath } from '../src/engine/systems/pathfinding';
import { getUnit, occupantAt } from '../src/engine/queries/selectors';
import { unitCost } from '../src/engine/systems/economy';

describe('createInitialState: error paths', () => {
  it('throws when an HQ is out of bounds (y)', () => {
    expect(() =>
      createInitialState({
        width: 3,
        height: 1,
        hqs: [
          { owner: 0, pos: { x: 0, y: 5 } },
          { owner: 1, pos: { x: 2, y: 0 } },
        ],
      }),
    ).toThrow();
  });

  it('throws when an HQ is out of bounds (x)', () => {
    expect(() =>
      createInitialState({
        width: 3,
        height: 1,
        hqs: [
          { owner: 0, pos: { x: -1, y: 0 } },
          { owner: 1, pos: { x: 2, y: 0 } },
        ],
      }),
    ).toThrow();
  });

  it('throws when a tile override is out of bounds (y)', () => {
    expect(() =>
      createInitialState({
        width: 3,
        height: 1,
        hqs: [
          { owner: 0, pos: { x: 0, y: 0 } },
          { owner: 1, pos: { x: 2, y: 0 } },
        ],
        tiles: [{ pos: { x: 0, y: 99 }, terrain: 'city' }],
      }),
    ).toThrow();
  });

  it('throws when a tile override is out of bounds (x)', () => {
    expect(() =>
      createInitialState({
        width: 3,
        height: 1,
        hqs: [
          { owner: 0, pos: { x: 0, y: 0 } },
          { owner: 1, pos: { x: 2, y: 0 } },
        ],
        tiles: [{ pos: { x: 99, y: 0 }, terrain: 'city' }],
      }),
    ).toThrow();
  });

  it('throws when both players are not assigned HQs', () => {
    expect(() =>
      createInitialState({
        width: 3,
        height: 1,
        hqs: [
          { owner: 0, pos: { x: 0, y: 0 } },
          { owner: 0, pos: { x: 2, y: 0 } },
        ],
      }),
    ).toThrow();
  });
});

describe('rng (mulberry32): determinism', () => {
  it('same seed produces the same sequence', () => {
    const a = createRng(0xdeadbeef);
    const b = createRng(0xdeadbeef);
    for (let i = 0; i < 20; i++) {
      expect(a()).toBe(b());
    }
  });

  it('rngInt returns ints in [0, max)', () => {
    const r = createRng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const n = rngInt(r, 5);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(5);
      seen.add(n);
    }
    // Sanity: with 100 draws we should hit at least 2 distinct values.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('rngPick picks an element from the array; throws on empty', () => {
    const r = createRng(42);
    const arr = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 10; i++) {
      expect(arr).toContain(rngPick(r, arr));
    }
    expect(() => rngPick(r, [])).toThrow();
  });
});

describe('pathfinding.validatePath: trivial cases', () => {
  it('empty path is OK with cost 0', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [{ type: 'infantry', owner: 0, pos: { x: 1, y: 0 } }],
    });
    const u = Object.values(s.units)[0]!;
    const r = validatePath(s, u, []);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cost).toBe(0);
  });
});

describe('selectors: ergonomic helpers', () => {
  it('getUnit returns the unit or undefined', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [{ type: 'infantry', owner: 0, pos: { x: 1, y: 0 } }],
    });
    const id = Object.keys(s.units)[0]!;
    expect(getUnit(s, id)).toBe(s.units[id]);
    expect(getUnit(s, 'no-such-id')).toBeUndefined();
  });

  it('occupantAt returns the unit on the tile or undefined', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [{ type: 'infantry', owner: 0, pos: { x: 1, y: 0 } }],
    });
    expect(occupantAt(s, { x: 1, y: 0 })).toBeDefined();
    expect(occupantAt(s, { x: 0, y: 0 })).toBeUndefined();
  });
});

describe('economy.unitCost', () => {
  it('matches the PLAN.md cost table', () => {
    expect(unitCost('infantry')).toBe(1000);
    expect(unitCost('recon')).toBe(4000);
    expect(unitCost('tank')).toBe(7000);
    expect(unitCost('artillery')).toBe(6000);
    expect(unitCost('copter')).toBe(9000);
  });
});
