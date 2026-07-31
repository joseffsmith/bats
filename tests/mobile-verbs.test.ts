// Pure-function tests for the mobile grammar's verb inference
// (src/renderer/mobile/verbs.ts). No DOM, no controller — just
// (state, unit, reachable, tile) → verb, and the two helpers that make a
// staged action deterministic.

import { describe, expect, it } from 'vitest';
import {
  bestAttackPosition,
  inferVerb,
  needsOrders,
} from '../src/renderer/mobile/verbs';
import { reachableTiles } from '../src/engine/queries/selectors';
import { makeState } from './test-helpers';
import type { GameState, Unit } from '../src/engine/core/types';

/** The (only) unit of `type` owned by `owner`. */
function unitOf(state: GameState, type: string, owner: 0 | 1): Unit {
  const u = Object.values(state.units).find(
    (x) => x.type === type && x.owner === owner,
  );
  if (!u) throw new Error(`no ${type} for player ${owner}`);
  return u;
}

function reach(state: GameState, unit: Unit) {
  return reachableTiles(state, unit);
}

// ───────────────────────── bestAttackPosition ────────────────────────────────

describe('bestAttackPosition: deterministic firing-tile choice', () => {
  it('prefers the tile with the most defense stars, even when it costs more', () => {
    // Tank at (0,1) closing on an enemy at (4,1). Three legal firing tiles:
    //   (3,1) plain,  cost 3, 1 star
    //   (4,2) plain,  cost 5, 1 star
    //   (4,0) forest, cost 6, 2 stars   ← should win on stars alone
    const state = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 2 } },
      ],
      tiles: [{ pos: { x: 4, y: 0 }, terrain: 'forest' }],
      units: [
        { type: 'tank', owner: 0, pos: { x: 0, y: 1 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 1 } },
      ],
    });
    const tank = unitOf(state, 'tank', 0);
    const enemy = unitOf(state, 'infantry', 1);
    const best = bestAttackPosition(state, tank, reach(state, tank), enemy);
    expect(best?.coord).toEqual({ x: 4, y: 0 });
  });

  it('breaks a defense-star tie on the lowest path cost', () => {
    // Same board, no forest: every firing tile is plain, so the cheapest wins.
    const state = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 2 } },
      ],
      units: [
        { type: 'tank', owner: 0, pos: { x: 0, y: 1 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 1 } },
      ],
    });
    const tank = unitOf(state, 'tank', 0);
    const enemy = unitOf(state, 'infantry', 1);
    const best = bestAttackPosition(state, tank, reach(state, tank), enemy);
    expect(best?.coord).toEqual({ x: 3, y: 1 });
    expect(best?.cost).toBe(3);
  });

  it('breaks a stars+cost tie on the lowest y', () => {
    // A friendly unit plugs (1,1), so the two equal-cost approaches to the
    // enemy at (2,1) are (2,0) and (2,2). Lowest y wins.
    const state = makeState({
      width: 5,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 2 } },
      ],
      units: [
        { type: 'tank', owner: 0, pos: { x: 0, y: 1 } },
        { type: 'infantry', owner: 0, pos: { x: 1, y: 1 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 1 } },
      ],
    });
    const tank = unitOf(state, 'tank', 0);
    const enemy = unitOf(state, 'infantry', 1);
    const best = bestAttackPosition(state, tank, reach(state, tank), enemy);
    expect(best?.coord).toEqual({ x: 2, y: 0 });
    expect(best?.cost).toBe(3);
  });

  it('breaks a stars+cost+y tie on the lowest x', () => {
    // Vertical mirror of the previous case: (0,2) and (2,2) tie on everything
    // down to y, so the lower x wins.
    const state = makeState({
      width: 3,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        { type: 'tank', owner: 0, pos: { x: 1, y: 4 } },
        { type: 'infantry', owner: 0, pos: { x: 1, y: 3 } },
        { type: 'infantry', owner: 1, pos: { x: 1, y: 2 } },
      ],
    });
    const tank = unitOf(state, 'tank', 0);
    const enemy = unitOf(state, 'infantry', 1);
    const best = bestAttackPosition(state, tank, reach(state, tank), enemy);
    expect(best?.coord).toEqual({ x: 0, y: 2 });
  });

  it('is order-independent: shuffling the reachable list changes nothing', () => {
    const state = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 2 } },
      ],
      tiles: [{ pos: { x: 4, y: 0 }, terrain: 'forest' }],
      units: [
        { type: 'tank', owner: 0, pos: { x: 0, y: 1 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 1 } },
      ],
    });
    const tank = unitOf(state, 'tank', 0);
    const enemy = unitOf(state, 'infantry', 1);
    const r = reach(state, tank);
    const forward = bestAttackPosition(state, tank, r, enemy);
    const reversed = bestAttackPosition(state, tank, [...r].reverse(), enemy);
    const again = bestAttackPosition(state, tank, r, enemy);
    expect(reversed?.coord).toEqual(forward?.coord);
    expect(again?.coord).toEqual(forward?.coord);
  });

  it('never picks a tile occupied by a friendly unit', () => {
    // (1,1) is the cheapest tile adjacent to the enemy but a friendly stands
    // there — reachableTiles won't offer it and we must not invent it.
    const state = makeState({
      width: 5,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 2 } },
      ],
      units: [
        { type: 'tank', owner: 0, pos: { x: 0, y: 1 } },
        { type: 'infantry', owner: 0, pos: { x: 1, y: 1 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 1 } },
      ],
    });
    const tank = unitOf(state, 'tank', 0);
    const enemy = unitOf(state, 'infantry', 1);
    const best = bestAttackPosition(state, tank, reach(state, tank), enemy);
    expect(best?.coord).not.toEqual({ x: 1, y: 1 });
  });

  describe('indirect units fire in place or not at all', () => {
    function artilleryState(enemyX: number): GameState {
      return makeState({
        width: 8,
        height: 1,
        defaultTerrain: 'plain',
        hqs: [
          { owner: 0, pos: { x: 0, y: 0 } },
          { owner: 1, pos: { x: 7, y: 0 } },
        ],
        units: [
          { type: 'artillery', owner: 0, pos: { x: 2, y: 0 } },
          { type: 'tank', owner: 1, pos: { x: enemyX, y: 0 } },
        ],
      });
    }

    it('returns the current tile with an empty path when already in range', () => {
      const state = artilleryState(4); // d = 2, range [2,3]
      const art = unitOf(state, 'artillery', 0);
      const enemy = unitOf(state, 'tank', 1);
      const best = bestAttackPosition(state, art, reach(state, art), enemy);
      expect(best).not.toBeNull();
      expect(best?.coord).toEqual({ x: 2, y: 0 });
      expect(best?.path).toEqual([]);
      expect(best?.cost).toBe(0);
    });

    it('returns null for a target inside the minimum range', () => {
      const state = artilleryState(3); // d = 1 < minRange 2
      const art = unitOf(state, 'artillery', 0);
      const enemy = unitOf(state, 'tank', 1);
      expect(bestAttackPosition(state, art, reach(state, art), enemy)).toBeNull();
    });

    it('returns null for a target beyond range, even if it could drive closer', () => {
      const state = artilleryState(6); // d = 4 > maxRange 3, move budget 5
      const art = unitOf(state, 'artillery', 0);
      const enemy = unitOf(state, 'tank', 1);
      expect(bestAttackPosition(state, art, reach(state, art), enemy)).toBeNull();
    });

    it('returns null once the indirect unit has moved this turn', () => {
      const state = artilleryState(4);
      const art = unitOf(state, 'artillery', 0);
      art.hasMoved = true;
      const enemy = unitOf(state, 'tank', 1);
      expect(bestAttackPosition(state, art, reach(state, art), enemy)).toBeNull();
    });
  });

  it('returns null for a spent unit, a non-combat unit, and a friendly target', () => {
    const state = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [
        { type: 'tank', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 3, y: 0 } },
      ],
    });
    const tank = unitOf(state, 'tank', 0);
    const friend = unitOf(state, 'infantry', 0);
    const enemy = unitOf(state, 'infantry', 1);
    expect(bestAttackPosition(state, tank, reach(state, tank), friend)).toBeNull();
    const spent = { ...tank, hasActed: true };
    expect(bestAttackPosition(state, spent, reach(state, spent), enemy)).toBeNull();
  });

  it('respects submerged-submarine stealth', () => {
    const state = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [
        { type: 'tank', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'cruiser', owner: 0, pos: { x: 3, y: 0 } },
        { type: 'submarine', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const sub = unitOf(state, 'submarine', 1);
    sub.submerged = true;
    const tank = unitOf(state, 'tank', 0);
    const cruiser = unitOf(state, 'cruiser', 0);
    // A tank cannot see, let alone shoot, a dived sub…
    expect(bestAttackPosition(state, tank, reach(state, tank), sub)).toBeNull();
    // …but a cruiser sitting next to it can.
    expect(bestAttackPosition(state, cruiser, reach(state, cruiser), sub)).not.toBeNull();
  });
});

// ───────────────────────────── inferVerb ─────────────────────────────────────

describe('inferVerb: what a tap means', () => {
  /**
   *   y=0: hq(p0)  city(p0)  .       .        .   .
   *   y=1: .       INF(p0)   .       ENEMY    .   .
   *   y=2: .       city(-)   city(p1) .       .   hq(p1)
   */
  function board(): GameState {
    return makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 2 } },
      ],
      tiles: [
        { pos: { x: 1, y: 0 }, terrain: 'city', owner: 0 },
        { pos: { x: 1, y: 2 }, terrain: 'city', owner: null },
        { pos: { x: 2, y: 2 }, terrain: 'city', owner: 1 },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 1 } },
        { type: 'infantry', owner: 1, pos: { x: 3, y: 1 } },
      ],
    });
  }

  function verb(state: GameState, x: number, y: number, unit?: Unit) {
    const u = unit ?? unitOf(state, 'infantry', 0);
    return inferVerb(state, u, reach(state, u), { x, y });
  }

  it('a reachable empty tile is a move', () => {
    expect(verb(board(), 2, 1)).toBe('move');
  });

  it('an enemy inside the unit’s attack reach is an attack', () => {
    expect(verb(board(), 3, 1)).toBe('attack');
  });

  it('a reachable neutral property is a capture', () => {
    expect(verb(board(), 1, 2)).toBe('capture');
  });

  it('a reachable enemy-owned property is a capture', () => {
    expect(verb(board(), 2, 2)).toBe('capture');
  });

  it('a property we already own is just a move', () => {
    expect(verb(board(), 1, 0)).toBe('move');
  });

  it('a property is a move for a unit that cannot capture', () => {
    const state = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 2 } },
      ],
      tiles: [{ pos: { x: 1, y: 2 }, terrain: 'city', owner: null }],
      units: [{ type: 'tank', owner: 0, pos: { x: 1, y: 1 } }],
    });
    expect(verb(state, 1, 2, unitOf(state, 'tank', 0))).toBe('move');
  });

  it('an out-of-reach tile is nothing', () => {
    // Infantry move budget 3; (5,0) is 5 steps away.
    expect(verb(board(), 5, 0)).toBeNull();
  });

  it('the unit’s own plain tile is nothing (the caller opens orders)', () => {
    expect(verb(board(), 1, 1)).toBeNull();
  });

  it('the unit’s own tile IS a capture when it stands on a neutral property', () => {
    const state = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 2, y: 0 }, terrain: 'city', owner: null }],
      units: [{ type: 'infantry', owner: 0, pos: { x: 2, y: 0 } }],
    });
    expect(verb(state, 2, 0)).toBe('capture');
  });

  it('a friendly unit’s tile is nothing (selection switch is the caller’s job)', () => {
    const state = board();
    state.units['u3'] = {
      id: 'u3',
      type: 'tank',
      owner: 0,
      pos: { x: 2, y: 1 },
      hp: 100,
      hasMoved: false,
      hasActed: false,
      captureProgress: 0,
    };
    expect(verb(state, 2, 1)).toBeNull();
  });

  it('a spent unit infers nothing at all', () => {
    const state = board();
    const inf = unitOf(state, 'infantry', 0);
    inf.hasActed = true;
    expect(verb(state, 2, 1)).toBeNull();
    expect(verb(state, 3, 1)).toBeNull();
  });

  describe('indirect units', () => {
    function artillery(enemyX: number): GameState {
      return makeState({
        width: 8,
        height: 1,
        defaultTerrain: 'plain',
        hqs: [
          { owner: 0, pos: { x: 0, y: 0 } },
          { owner: 1, pos: { x: 7, y: 0 } },
        ],
        units: [
          { type: 'artillery', owner: 0, pos: { x: 2, y: 0 } },
          { type: 'tank', owner: 1, pos: { x: enemyX, y: 0 } },
        ],
      });
    }

    it('an in-range enemy is an attack', () => {
      const state = artillery(4);
      expect(verb(state, 4, 0, unitOf(state, 'artillery', 0))).toBe('attack');
    });

    it('an adjacent (too-close) enemy is nothing', () => {
      const state = artillery(3);
      expect(verb(state, 3, 0, unitOf(state, 'artillery', 0))).toBeNull();
    });

    it('an enemy it could only reach by driving is nothing', () => {
      const state = artillery(6);
      expect(verb(state, 6, 0, unitOf(state, 'artillery', 0))).toBeNull();
    });
  });
});

// ──────────────────────────── needsOrders ────────────────────────────────────

describe('needsOrders: the only reason the mobile grammar asks', () => {
  /** Infantry on `terrain`(owner `tileOwner`) at (1,0), enemy adjacent iff `enemy`. */
  function scenario(opts: {
    terrain: 'plain' | 'city' | 'hq';
    tileOwner: 0 | 1 | null;
    enemy: boolean;
    unitType?: 'infantry' | 'tank';
  }): { state: GameState; unit: Unit } {
    const state = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: opts.terrain, owner: opts.tileOwner }],
      units: [
        { type: opts.unitType ?? 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        ...(opts.enemy
          ? ([{ type: 'infantry', owner: 1 as const, pos: { x: 2, y: 0 } }] as const)
          : []),
      ],
    });
    const unit = unitOf(state, opts.unitType ?? 'infantry', 0);
    unit.hasMoved = true; // needsOrders is asked right after a MOVE lands
    return { state, unit };
  }

  it('true: capturable non-owned tile AND an attackable enemy', () => {
    const { state, unit } = scenario({ terrain: 'city', tileOwner: null, enemy: true });
    expect(needsOrders(state, unit)).toBe(true);
  });

  it('true on an enemy-owned property too', () => {
    const { state, unit } = scenario({ terrain: 'city', tileOwner: 1, enemy: true });
    expect(needsOrders(state, unit)).toBe(true);
  });

  it('true on a capturable HQ', () => {
    const { state, unit } = scenario({ terrain: 'hq', tileOwner: 1, enemy: true });
    expect(needsOrders(state, unit)).toBe(true);
  });

  it('false: capturable tile but nothing to shoot', () => {
    const { state, unit } = scenario({ terrain: 'city', tileOwner: null, enemy: false });
    expect(needsOrders(state, unit)).toBe(false);
  });

  it('false: enemy adjacent but the tile is not capturable', () => {
    const { state, unit } = scenario({ terrain: 'plain', tileOwner: null, enemy: true });
    expect(needsOrders(state, unit)).toBe(false);
  });

  it('false: we already own the property', () => {
    const { state, unit } = scenario({ terrain: 'city', tileOwner: 0, enemy: true });
    expect(needsOrders(state, unit)).toBe(false);
  });

  it('false: the unit cannot capture', () => {
    const { state, unit } = scenario({
      terrain: 'city',
      tileOwner: null,
      enemy: true,
      unitType: 'tank',
    });
    expect(needsOrders(state, unit)).toBe(false);
  });

  it('false: the unit has already acted', () => {
    const { state, unit } = scenario({ terrain: 'city', tileOwner: null, enemy: true });
    unit.hasActed = true;
    expect(needsOrders(state, unit)).toBe(false);
  });
});
