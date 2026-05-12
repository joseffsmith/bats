import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';

describe('capture', () => {
  it('two full-HP captures flip a neutral city to the infantry owner', () => {
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
        // Dummy enemy unit to avoid the rout win condition.
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const infId = Object.keys(s.units)[0]!;
    let st = s;
    st = reduce(st, { type: 'CAPTURE', unitId: infId });
    // progress = floor(100/10) = 10; not yet flipped
    expect(st.units[infId]!.captureProgress).toBe(10);
    expect(st.map[0]![1]!.owner).toBeNull();

    // End the turn, swap to player 1, then back, so flags reset.
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'CAPTURE', unitId: infId });
    // progress hits 20 → flip → reset to 0
    expect(st.units[infId]!.captureProgress).toBe(0);
    expect(st.map[0]![1]!.owner).toBe(0);
  });

  it('moving off a capturable tile resets progress', () => {
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
    const infId = Object.keys(s.units)[0]!;
    let st = reduce(s, { type: 'CAPTURE', unitId: infId });
    expect(st.units[infId]!.captureProgress).toBe(10);
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, {
      type: 'MOVE',
      unitId: infId,
      path: [{ x: 2, y: 0 }],
    });
    expect(st.units[infId]!.captureProgress).toBe(0);
  });
});
