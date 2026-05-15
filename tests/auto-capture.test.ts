// Regression tests for the auto-capture-on-END_TURN fix in
// `src/engine/core/reducer.ts > applyEndTurn`.
//
// Genre convention (Advance Wars / Wargroove): once an infantry starts
// capturing, ending the turn while still standing on the same non-owned
// capturable tile continues the capture automatically — the player doesn't
// have to re-select the unit and pick Capture every turn. The override is
// any other action this turn (Move/Attack/Wait), which sets hasActed=true.

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';

describe('END_TURN auto-capture', () => {
  it('infantry on a neutral city: END_TURN adds captureProgress = 10', () => {
    const s = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        // Dummy enemy unit so rout-win doesn't trigger.
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const infId = Object.values(s.units).find((u) => u.owner === 0)!.id;
    expect(s.units[infId]!.captureProgress).toBe(0);
    const after = reduce(s, { type: 'END_TURN' });
    expect(after.units[infId]!.captureProgress).toBe(10);
    // City still neutral (10 < 20 threshold).
    expect(after.map[0]![1]!.owner).toBeNull();
  });

  it('infantry that already CAPTUREd this turn: END_TURN does NOT double-add', () => {
    const s = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const infId = Object.values(s.units).find((u) => u.owner === 0)!.id;
    let st = reduce(s, { type: 'CAPTURE', unitId: infId });
    expect(st.units[infId]!.captureProgress).toBe(10);
    expect(st.units[infId]!.hasActed).toBe(true);
    // END_TURN must NOT add a second 10 — the unit already acted.
    st = reduce(st, { type: 'END_TURN' });
    expect(st.units[infId]!.captureProgress).toBe(10);
    expect(st.map[0]![1]!.owner).toBeNull();
  });

  it('infantry on own-owned city: END_TURN does not affect captureProgress', () => {
    const s = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      // City already owned by player 0 — auto-capture skip path.
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: 0 }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const infId = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const after = reduce(s, { type: 'END_TURN' });
    expect(after.units[infId]!.captureProgress).toBe(0);
    expect(after.map[0]![1]!.owner).toBe(0);
  });

  it('two consecutive player-end-turns: city flips on the 2nd own turn (10 + 10 = 20)', () => {
    const s = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const infId = Object.values(s.units).find((u) => u.owner === 0)!.id;
    // P0 ends turn → auto-capture adds 10.
    let st = reduce(s, { type: 'END_TURN' });
    expect(st.units[infId]!.captureProgress).toBe(10);
    expect(st.map[0]![1]!.owner).toBeNull();
    // P1 ends turn → no effect on the P0 infantry.
    st = reduce(st, { type: 'END_TURN' });
    expect(st.units[infId]!.captureProgress).toBe(10);
    expect(st.map[0]![1]!.owner).toBeNull();
    // Back on P0's turn — flags reset, unit can auto-capture again at END_TURN.
    expect(st.units[infId]!.hasActed).toBe(false);
    st = reduce(st, { type: 'END_TURN' });
    // 10 + 10 = 20 → flip, progress resets to 0, city now owned by P0.
    expect(st.units[infId]!.captureProgress).toBe(0);
    expect(st.map[0]![1]!.owner).toBe(0);
  });

  it('a tank on a city: END_TURN does NOT trigger capture (canCapture=false)', () => {
    const s = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'tank', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const tankId = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const after = reduce(s, { type: 'END_TURN' });
    expect(after.units[tankId]!.captureProgress).toBe(0);
    expect(after.map[0]![1]!.owner).toBeNull();
  });

  it('a recon on a city: END_TURN does NOT trigger capture (canCapture=false)', () => {
    const s = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'recon', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const reconId = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const after = reduce(s, { type: 'END_TURN' });
    expect(after.units[reconId]!.captureProgress).toBe(0);
    expect(after.map[0]![1]!.owner).toBeNull();
  });

  it('WAITed infantry on a capturable tile: END_TURN does NOT auto-capture', () => {
    const s = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const infId = Object.values(s.units).find((u) => u.owner === 0)!.id;
    let st = reduce(s, { type: 'WAIT', unitId: infId });
    expect(st.units[infId]!.hasActed).toBe(true);
    expect(st.units[infId]!.captureProgress).toBe(0);
    st = reduce(st, { type: 'END_TURN' });
    // WAIT consumed the action — auto-capture must skip this unit.
    expect(st.units[infId]!.captureProgress).toBe(0);
    expect(st.map[0]![1]!.owner).toBeNull();
  });

  it('also works on neutral factory and neutral HQ (any capturable terrain)', () => {
    // Belt-and-braces: the fix uses isCapturable(), so factories qualify too.
    const s = makeState({
      width: 6,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 0 } },
      ],
      tiles: [
        { pos: { x: 1, y: 0 }, terrain: 'factory', owner: null },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 5, y: 0 } },
      ],
    });
    const infId = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const after = reduce(s, { type: 'END_TURN' });
    expect(after.units[infId]!.captureProgress).toBe(10);
  });

  it('auto-capture only applies to the player whose turn is ending', () => {
    // Both players have an infantry on a neutral city. Only P0's should
    // accrue progress on P0's END_TURN; P1's must stay at 0.
    const s = makeState({
      width: 6,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 0 } },
      ],
      tiles: [
        { pos: { x: 1, y: 0 }, terrain: 'city', owner: null },
        { pos: { x: 4, y: 0 }, terrain: 'city', owner: null },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const p0Inf = Object.values(s.units).find((u) => u.owner === 0)!;
    const p1Inf = Object.values(s.units).find((u) => u.owner === 1)!;
    const after = reduce(s, { type: 'END_TURN' });
    expect(after.units[p0Inf.id]!.captureProgress).toBe(10);
    expect(after.units[p1Inf.id]!.captureProgress).toBe(0);
  });
});
