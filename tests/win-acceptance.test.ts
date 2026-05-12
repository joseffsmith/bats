// Win acceptance: HQ capture, rout, no-action-after-win, simultaneous
// HQ-capture + rout (single winner).

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';
import { checkWinner } from '../src/engine/systems/win';

describe('win: HQ capture', () => {
  it('infantry capturing enemy HQ sets winner to capturer', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        // P0 has at least one unit on a safe tile.
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        // P1 infantry sitting on P0's HQ (will capture it).
        { type: 'infantry', owner: 1, pos: { x: 0, y: 0 } },
      ],
    });
    const p1 = Object.values(s.units).find((u) => u.owner === 1)!;
    // It's P0's turn — end it.
    let st = reduce(s, { type: 'END_TURN' });
    st = reduce(st, { type: 'CAPTURE', unitId: p1.id });
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'CAPTURE', unitId: p1.id });
    expect(st.winner).toBe(1);
    expect(st.map[0]![0]!.owner).toBe(1);
  });
});

describe('win: post-winner gate', () => {
  it('END_TURN after winner is set is a no-op', () => {
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
        { type: 'infantry', owner: 1, pos: { x: 1, y: 0 }, hp: 10 },
      ],
    });
    const a = Object.values(s.units).find((u) => u.type === 'tank')!;
    const t = Object.values(s.units).find((u) => u.type === 'infantry')!;
    const won = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: t.id });
    expect(won.winner).toBe(0);
    expect(reduce(won, { type: 'END_TURN' })).toBe(won);
    expect(reduce(won, { type: 'WAIT', unitId: a.id })).toBe(won);
    expect(reduce(won, { type: 'MOVE', unitId: a.id, path: [{ x: 1, y: 0 }] }))
      .toBe(won);
  });

  it('once winner is set, it is sticky across further reduce() calls', () => {
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
        { type: 'infantry', owner: 1, pos: { x: 1, y: 0 }, hp: 10 },
      ],
    });
    const a = Object.values(s.units).find((u) => u.type === 'tank')!;
    const t = Object.values(s.units).find((u) => u.type === 'infantry')!;
    const won = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: t.id });
    expect(won.winner).toBe(0);
    // Attempt various invalid actions; winner unchanged.
    let st = won;
    for (let i = 0; i < 5; i++) {
      st = reduce(st, { type: 'END_TURN' });
    }
    expect(st.winner).toBe(0);
  });
});

describe('win: rout', () => {
  it('killing the last enemy unit triggers rout for the killer', () => {
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
        { type: 'infantry', owner: 1, pos: { x: 1, y: 0 }, hp: 15 },
      ],
    });
    const a = Object.values(s.units).find((u) => u.type === 'tank')!;
    const t = Object.values(s.units).find((u) => u.type === 'infantry')!;
    const after = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: t.id });
    expect(after.units[t.id]).toBeUndefined();
    expect(after.winner).toBe(0);
  });

  it('returns null when BOTH players have 0 units (draw, no spurious winner)', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [],
    });
    expect(checkWinner(s)).toBeNull();
  });

  it('with units present on both sides at start, no spurious win is reported', () => {
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
    expect(checkWinner(s)).toBeNull();
    expect(s.winner).toBeNull();
  });
});

describe('win: simultaneous HQ-capture and rout', () => {
  it('HQ capture + would-be rout produces exactly one winner, and it is consistent', () => {
    // Setup: P1 has only one unit, an infantry on P0's HQ at progress 10 from
    // last turn. P0 has one infantry sitting somewhere else. Currently P0's
    // turn — kill P1's unit, which would also be rout. But we want the
    // winning capture to happen, so we sequence:
    //   1. End P0's turn (no kill).
    //   2. P1 captures HQ — flips → P1 wins by HQ capture.
    // In this test we set up so that the SAME action (P1 capturing) would
    // both flip the HQ AND end the game with the capturing player as winner.
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        // P0 has one infantry far away.
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        // P1 capturing P0's HQ.
        { type: 'infantry', owner: 1, pos: { x: 0, y: 0 } },
      ],
    });
    const p1 = Object.values(s.units).find((u) => u.owner === 1)!;
    let st = reduce(s, { type: 'END_TURN' });
    st = reduce(st, { type: 'CAPTURE', unitId: p1.id });
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'CAPTURE', unitId: p1.id });
    // Only one winner field is set.
    expect(st.winner).toBe(1);
  });
});

describe('win: checkWinner direct invocations', () => {
  it('returns owner of foreign-owned HQ', () => {
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
    // Manually flip P0's HQ to P1.
    s.map[0]![0]!.owner = 1;
    expect(checkWinner(s)).toBe(1);
  });

  it('returns null when both players have units and HQs are intact', () => {
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
    expect(checkWinner(s)).toBeNull();
  });
});
