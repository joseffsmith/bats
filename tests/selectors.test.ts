import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import {
  attackableTargets,
  tilesInRange,
} from '../src/engine/queries/selectors';

describe('selectors', () => {
  it('tilesInRange enumerates the Manhattan annulus, clipped to bounds', () => {
    const s = makeState({
      width: 5,
      height: 5,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 4 } },
      ],
    });
    const r = tilesInRange(s, { x: 2, y: 2 }, 2, 3);
    // Should not include (2,2) (range >=2), nor any out-of-bounds.
    expect(r.every((c) => Math.abs(c.x - 2) + Math.abs(c.y - 2) >= 2)).toBe(true);
    expect(r.every((c) => Math.abs(c.x - 2) + Math.abs(c.y - 2) <= 3)).toBe(true);
  });

  it('attackableTargets finds enemies within unit range and excludes friendlies', () => {
    const s = makeState({
      width: 6,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 0 } },
      ],
      units: [
        { type: 'artillery', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 1, y: 0 } }, // range 1 — too close for artillery
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } }, // range 2 OK
        { type: 'infantry', owner: 1, pos: { x: 3, y: 0 } }, // range 3 OK
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } }, // range 4 — too far
        { type: 'infantry', owner: 0, pos: { x: 5, y: 0 } }, // friendly — never a target
      ],
    });
    const art = Object.values(s.units).find((u) => u.type === 'artillery')!;
    const targets = attackableTargets(s, art);
    const dists = targets.map((t) => Math.abs(t.pos.x - art.pos.x)).sort();
    expect(dists).toEqual([2, 3]); // not 1, not 4, not friendly at 5
  });
});
