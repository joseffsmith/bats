// Match adjudication query (src/engine/queries/adjudicate.ts).
//
// The ladder is: real winner → more HQ tiles → more HP-weighted unit cost by a
// margin > 1 → draw. It is a QUERY, so the tests also pin the thing that makes
// it safe to call from the shells: it never touches `state.winner`, and it
// never mutates the state it is handed.

import { describe, expect, it } from 'vitest';
import {
  MATERIAL_MARGIN,
  adjudicate,
  hqTilesOwned,
  materialValue,
} from '../src/engine/queries/adjudicate';
import { UNITS } from '../src/engine/data';
import type { GameState, PlayerId } from '../src/engine/core/types';
import { makeState } from './test-helpers';

/** Both HQs owned by their own side, no units — a blank slate the individual
 *  tests bend one rung at a time. */
function board(): GameState {
  return makeState({
    width: 8,
    height: 8,
    hqs: [
      { owner: 0, pos: { x: 0, y: 0 } },
      { owner: 1, pos: { x: 7, y: 7 } },
    ],
  });
}

function withUnits(
  state: GameState,
  specs: ReadonlyArray<{ owner: PlayerId; type: 'infantry' | 'tank'; hp?: number }>,
): GameState {
  const next = structuredClone(state);
  next.units = {};
  specs.forEach((spec, i) => {
    const id = `u${i}`;
    next.units[id] = {
      id,
      type: spec.type,
      owner: spec.owner,
      pos: { x: i + 1, y: 3 },
      hp: spec.hp ?? 100,
      hasMoved: false,
      hasActed: false,
      captureProgress: 0,
    };
  });
  return next;
}

/** Turn a plain tile into an extra HQ owned by `owner` (null = unclaimed). */
function extraHq(
  state: GameState,
  x: number,
  y: number,
  owner: PlayerId | null,
): GameState {
  const next = structuredClone(state);
  next.map[y]![x] = { terrain: 'hq', owner };
  return next;
}

describe('adjudicate — rung 1: a real winner short-circuits', () => {
  it('returns the engine winner even when the loser is ahead on material', () => {
    // P1 owns a second HQ and a tank; P0 owns nothing but the win.
    let s = withUnits(board(), [{ owner: 1, type: 'tank' }]);
    s = extraHq(s, 4, 4, 1);
    s.winner = 0;
    expect(adjudicate(s)).toBe(0);
  });

  it('returns player 1 when player 1 won', () => {
    const s = { ...board(), winner: 1 as PlayerId };
    expect(adjudicate(s)).toBe(1);
  });
});

describe('adjudicate — rung 2: HQ count decides', () => {
  it('more HQ tiles wins, outranking a material deficit', () => {
    // P0 holds two HQs but only an infantry; P1 holds one HQ and a tank.
    let s = withUnits(board(), [
      { owner: 0, type: 'infantry' },
      { owner: 1, type: 'tank' },
    ]);
    s = extraHq(s, 4, 4, 0);
    expect(hqTilesOwned(s, 0)).toBe(2);
    expect(hqTilesOwned(s, 1)).toBe(1);
    expect(materialValue(s, 1)).toBeGreaterThan(materialValue(s, 0));
    expect(adjudicate(s)).toBe(0);
  });

  it('symmetrically, more HQ tiles for player 1 wins', () => {
    const s = extraHq(board(), 4, 4, 1);
    expect(adjudicate(s)).toBe(1);
  });

  it('an unowned HQ tile counts for nobody', () => {
    const s = extraHq(board(), 4, 4, null);
    expect(hqTilesOwned(s, 0)).toBe(1);
    expect(hqTilesOwned(s, 1)).toBe(1);
    expect(adjudicate(s)).toBe('draw');
  });
});

describe('adjudicate — rung 3: material margin decides', () => {
  it('equal HQs, more HP-weighted cost wins', () => {
    const s = withUnits(board(), [
      { owner: 0, type: 'tank' },
      { owner: 1, type: 'infantry' },
    ]);
    expect(adjudicate(s)).toBe(0);
  });

  it('damage counts: two half-HP tanks lose to one full tank + an infantry', () => {
    const s = withUnits(board(), [
      { owner: 0, type: 'tank', hp: 100 },
      { owner: 0, type: 'infantry', hp: 100 },
      { owner: 1, type: 'tank', hp: 50 },
      { owner: 1, type: 'tank', hp: 50 },
    ]);
    expect(materialValue(s, 0)).toBe(UNITS.tank.cost + UNITS.infantry.cost);
    expect(materialValue(s, 1)).toBe(UNITS.tank.cost);
    expect(adjudicate(s)).toBe(0);
  });

  it('symmetrically, player 1 ahead on material wins', () => {
    const s = withUnits(board(), [
      { owner: 0, type: 'infantry' },
      { owner: 1, type: 'tank' },
    ]);
    expect(adjudicate(s)).toBe(1);
  });
});

describe('adjudicate — rung 4: draw', () => {
  it('mirrored boards draw', () => {
    const s = withUnits(board(), [
      { owner: 0, type: 'tank' },
      { owner: 1, type: 'tank' },
    ]);
    expect(adjudicate(s)).toBe('draw');
  });

  it('empty boards draw', () => {
    expect(adjudicate(board())).toBe('draw');
  });

  it('a lead of exactly the margin is NOT enough — the ladder needs > 1', () => {
    // Build a lead of exactly MATERIAL_MARGIN by shaving HP off one side.
    // infantry cost 1000 → 0.1 HP-points of cost per HP, so 1 funds = 0.1 HP.
    const perHp = UNITS.infantry.cost / 100;
    const hp = 100 - MATERIAL_MARGIN / perHp;
    const s = withUnits(board(), [
      { owner: 0, type: 'infantry', hp: 100 },
      { owner: 1, type: 'infantry', hp },
    ]);
    expect(materialValue(s, 0) - materialValue(s, 1)).toBeCloseTo(MATERIAL_MARGIN, 8);
    expect(adjudicate(s)).toBe('draw');
  });

  it('a lead just over the margin IS enough', () => {
    const perHp = UNITS.infantry.cost / 100;
    const hp = 100 - (MATERIAL_MARGIN + 0.5) / perHp;
    const s = withUnits(board(), [
      { owner: 0, type: 'infantry', hp: 100 },
      { owner: 1, type: 'infantry', hp },
    ]);
    expect(adjudicate(s)).toBe(0);
  });
});

describe('adjudicate — purity', () => {
  it('never writes a winner and never mutates the state', () => {
    const s = withUnits(board(), [
      { owner: 0, type: 'tank' },
      { owner: 1, type: 'infantry' },
    ]);
    const before = structuredClone(s);
    expect(adjudicate(s)).toBe(0);
    expect(s.winner).toBeNull();
    expect(s).toEqual(before);
  });
});
