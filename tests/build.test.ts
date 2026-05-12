// BUILD action coverage: legality, funds deduction, deterministic ids.

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';

describe('BUILD: happy path', () => {
  it('spawns the requested unit on the factory tile, locked this turn', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'factory', owner: 0 }],
      units: [{ type: 'infantry', owner: 1, pos: { x: 2, y: 0 } }],
      funds: { 0: 7000 },
    });
    const next = reduce(s, {
      type: 'BUILD',
      at: { x: 1, y: 0 },
      unitType: 'tank',
      owner: 0,
    });
    const built = Object.values(next.units).find(
      (u) => u.owner === 0 && u.type === 'tank',
    );
    expect(built).toBeDefined();
    expect(built!.pos).toEqual({ x: 1, y: 0 });
    expect(built!.hp).toBe(100);
    expect(built!.hasMoved).toBe(true);
    expect(built!.hasActed).toBe(true);
    expect(built!.captureProgress).toBe(0);
  });

  it('deducts the exact unit cost from owner funds', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'factory', owner: 0 }],
      units: [{ type: 'infantry', owner: 1, pos: { x: 2, y: 0 } }],
      funds: { 0: 10000 },
    });
    // Cost-tagged unit types and their PLAN.md costs.
    for (const [t, expected] of [
      ['infantry', 9000],
      ['recon', 6000],
      ['tank', 3000],
    ] as const) {
      const next = reduce(s, {
        type: 'BUILD',
        at: { x: 1, y: 0 },
        unitType: t,
        owner: 0,
      });
      // Wait — same `s` reused; only first build applies (subsequent are
      // rejected because tile occupied). Re-test each by creating fresh.
      void next;
      void expected;
    }
    // Single-build assertion, fresh state per type.
    for (const [type, expectedAfter] of [
      ['infantry', 9000],
      ['recon', 6000],
      ['tank', 3000],
      ['artillery', 4000],
    ] as const) {
      const fresh = makeState({
        width: 3,
        height: 1,
        hqs: [
          { owner: 0, pos: { x: 0, y: 0 } },
          { owner: 1, pos: { x: 2, y: 0 } },
        ],
        tiles: [{ pos: { x: 1, y: 0 }, terrain: 'factory', owner: 0 }],
        units: [{ type: 'infantry', owner: 1, pos: { x: 2, y: 0 } }],
        funds: { 0: 10000 },
      });
      const after = reduce(fresh, {
        type: 'BUILD',
        at: { x: 1, y: 0 },
        unitType: type,
        owner: 0,
      });
      expect(after.players[0]!.funds).toBe(expectedAfter);
    }
  });

  it('assigns deterministic sequential unit ids via nextUnitId', () => {
    const s = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [
        { pos: { x: 1, y: 0 }, terrain: 'factory', owner: 0 },
        { pos: { x: 2, y: 0 }, terrain: 'factory', owner: 0 },
      ],
      units: [{ type: 'infantry', owner: 1, pos: { x: 4, y: 0 } }],
      funds: { 0: 5000 },
    });
    expect(s.nextUnitId).toBe(2);
    const built1 = reduce(s, {
      type: 'BUILD',
      at: { x: 1, y: 0 },
      unitType: 'infantry',
      owner: 0,
    });
    expect(built1.nextUnitId).toBe(3);
    expect(built1.units['u2']).toBeDefined();
    const built2 = reduce(built1, {
      type: 'BUILD',
      at: { x: 2, y: 0 },
      unitType: 'infantry',
      owner: 0,
    });
    expect(built2.nextUnitId).toBe(4);
    expect(built2.units['u3']).toBeDefined();
  });
});

describe('BUILD: legality', () => {
  it('rejects BUILD on enemy-owned factory', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'factory', owner: 1 }],
      units: [{ type: 'infantry', owner: 1, pos: { x: 2, y: 0 } }],
      funds: { 0: 5000 },
    });
    const next = reduce(s, {
      type: 'BUILD',
      at: { x: 1, y: 0 },
      unitType: 'infantry',
      owner: 0,
    });
    expect(next).toBe(s);
  });

  it('rejects BUILD on a neutral (unowned) factory', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'factory', owner: null }],
      units: [{ type: 'infantry', owner: 1, pos: { x: 2, y: 0 } }],
      funds: { 0: 5000 },
    });
    const next = reduce(s, {
      type: 'BUILD',
      at: { x: 1, y: 0 },
      unitType: 'infantry',
      owner: 0,
    });
    expect(next).toBe(s);
  });

  it('rejects BUILD on a non-factory tile (city, plain, road, hq)', () => {
    for (const terrain of ['city', 'plain', 'road', 'hq'] as const) {
      const s = makeState({
        width: 3,
        height: 1,
        defaultTerrain: 'road',
        hqs: [
          { owner: 0, pos: { x: 0, y: 0 } },
          { owner: 1, pos: { x: 2, y: 0 } },
        ],
        tiles: terrain === 'hq'
          ? []
          : [{ pos: { x: 1, y: 0 }, terrain, owner: 0 }],
        units: [{ type: 'infantry', owner: 1, pos: { x: 2, y: 0 } }],
        funds: { 0: 5000 },
      });
      const target = terrain === 'hq' ? { x: 0, y: 0 } : { x: 1, y: 0 };
      const next = reduce(s, {
        type: 'BUILD',
        at: target,
        unitType: 'infantry',
        owner: 0,
      });
      expect(next).toBe(s);
    }
  });

  it('rejects BUILD when funds are insufficient', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'factory', owner: 0 }],
      units: [{ type: 'infantry', owner: 1, pos: { x: 2, y: 0 } }],
      funds: { 0: 500 }, // infantry costs 1000
    });
    const next = reduce(s, {
      type: 'BUILD',
      at: { x: 1, y: 0 },
      unitType: 'infantry',
      owner: 0,
    });
    expect(next).toBe(s);
  });

  it('rejects BUILD on an occupied factory tile', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'factory', owner: 0 }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
      funds: { 0: 5000 },
    });
    const next = reduce(s, {
      type: 'BUILD',
      at: { x: 1, y: 0 },
      unitType: 'infantry',
      owner: 0,
    });
    expect(next).toBe(s);
  });

  it('rejects BUILD with out-of-bounds coords', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [{ type: 'infantry', owner: 1, pos: { x: 2, y: 0 } }],
      funds: { 0: 5000 },
    });
    const next = reduce(s, {
      type: 'BUILD',
      at: { x: 99, y: 0 },
      unitType: 'infantry',
      owner: 0,
    });
    expect(next).toBe(s);
  });

  it('rejects BUILD where owner field differs from currentPlayer', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'factory', owner: 1 }],
      units: [{ type: 'infantry', owner: 1, pos: { x: 2, y: 0 } }],
      funds: { 1: 5000 },
    });
    // It's P0's turn; passing owner: 1 should be rejected.
    const next = reduce(s, {
      type: 'BUILD',
      at: { x: 1, y: 0 },
      unitType: 'infantry',
      owner: 1,
    });
    expect(next).toBe(s);
  });
});
