import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';

describe('reducer', () => {
  it('illegal action is a no-op (state unchanged)', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [{ type: 'infantry', owner: 1, pos: { x: 2, y: 0 } }],
    });
    // Player 0's turn — moving player 1's unit is illegal.
    const id = Object.keys(s.units)[0]!;
    const next = reduce(s, {
      type: 'MOVE',
      unitId: id,
      path: [{ x: 1, y: 0 }],
    });
    expect(next).toBe(s); // exact same reference
  });

  it('MOVE relocates the unit and sets hasMoved (not hasActed)', () => {
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      units: [{ type: 'infantry', owner: 0, pos: { x: 0, y: 0 } }],
    });
    const id = Object.keys(s.units)[0]!;
    const next = reduce(s, {
      type: 'MOVE',
      unitId: id,
      path: [{ x: 1, y: 0 }, { x: 2, y: 0 }],
    });
    expect(next.units[id]!.pos).toEqual({ x: 2, y: 0 });
    expect(next.units[id]!.hasMoved).toBe(true);
    expect(next.units[id]!.hasActed).toBe(false);
  });

  it('WAIT marks a unit done for the turn', () => {
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
    const next = reduce(s, { type: 'WAIT', unitId: id });
    expect(next.units[id]!.hasMoved).toBe(true);
    expect(next.units[id]!.hasActed).toBe(true);
  });

  it('does not mutate the input state', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [{ type: 'infantry', owner: 0, pos: { x: 0, y: 0 } }],
    });
    const id = Object.keys(s.units)[0]!;
    const snapshot = structuredClone(s);
    reduce(s, { type: 'MOVE', unitId: id, path: [{ x: 1, y: 0 }] });
    expect(s).toEqual(snapshot);
  });
});
