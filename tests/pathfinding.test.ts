import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reachableTiles, validatePath } from '../src/engine/systems/pathfinding';

describe('pathfinding', () => {
  it('infantry on a 5x5 plain map reaches all tiles within move=3', () => {
    const s = makeState({
      width: 5,
      height: 5,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 4 } },
      ],
      units: [{ type: 'infantry', owner: 0, pos: { x: 2, y: 2 } }],
    });
    const u = Object.values(s.units)[0]!;
    const reach = reachableTiles(s, u);
    // Reachable = Manhattan-distance ≤ 3 from (2,2) on plain (cost 1 each for foot).
    // Excludes tiles occupied by other units (none here besides self).
    const dests = reach.map((r) => `${r.coord.x},${r.coord.y},${r.cost}`).sort();
    // start is included with cost 0
    expect(dests).toContain('2,2,0');
    // Manhattan-1 step has cost 1.
    expect(dests).toContain('3,2,1');
    // The full-budget corner.
    expect(dests).toContain('2,4,2');
    // Out of budget — Manhattan 4.
    expect(dests).not.toContain('0,0,4');
  });

  it('impassable terrain blocks tread units', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'mountain' }],
      units: [{ type: 'tank', owner: 0, pos: { x: 0, y: 0 } }],
    });
    const u = Object.values(s.units)[0]!;
    const reach = reachableTiles(s, u);
    // Tank cannot enter mountain (move cost ∞), so (1,0) and (2,0) unreachable.
    const set = new Set(reach.map((r) => `${r.coord.x},${r.coord.y}`));
    expect(set.has('0,0')).toBe(true);
    expect(set.has('1,0')).toBe(false);
    expect(set.has('2,0')).toBe(false);
  });

  it('validatePath rejects non-adjacent steps', () => {
    const s = makeState({
      width: 3,
      height: 3,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 2 } },
      ],
      units: [{ type: 'infantry', owner: 0, pos: { x: 0, y: 0 } }],
    });
    const u = Object.values(s.units)[0]!;
    const r = validatePath(s, u, [{ x: 2, y: 0 }]);
    expect(r.ok).toBe(false);
  });

  it('cannot stop on an own friendly unit but can pass through one', () => {
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
      ],
    });
    const u = Object.values(s.units)[0]!; // at (0,0)
    const reach = reachableTiles(s, u);
    const set = new Set(reach.map((r) => `${r.coord.x},${r.coord.y}`));
    expect(set.has('1,0')).toBe(false); // can't stop on friendly
    expect(set.has('2,0')).toBe(true); // can pass through and stop on (2,0)
  });
});
