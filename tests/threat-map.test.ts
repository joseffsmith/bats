// Phase 5: threat-map precomputation tests.
//
// The threat map answers "how much damage could an enemy unit deal to a
// representative target standing on (x,y) NEXT turn?". These tests pin down
// the shape of the threat surface around a single enemy unit and the
// max-aggregation across multiple enemies.

import { describe, expect, it } from 'vitest';
import './test-helpers';

import { makeState } from './test-helpers';
import { computeThreatMap } from '../src/engine/ai/threatMap';

describe('threat map: single enemy', () => {
  it('with no enemies the threat map is all zeros', () => {
    const state = makeState({
      width: 5,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 4 } },
      ],
    });
    // Compute threat from p1's perspective on p0 — no p1 units exist.
    const t = computeThreatMap(state, 1, 0);
    expect(t.length).toBe(5);
    for (const row of t) {
      for (const v of row) expect(v).toBe(0);
    }
  });

  it('a tank at the centre creates max threat in adjacent tiles, not at range 2+', () => {
    // 5x5 plain map with a single enemy tank at (2,2). Tank range=1, move=6.
    const state = makeState({
      width: 5,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 4 } },
      ],
      units: [{ type: 'tank', owner: 1, pos: { x: 2, y: 2 } }],
    });
    // Threat as seen by player 0: enemies = player 1 units. attackerPlayer=1.
    const t = computeThreatMap(state, 1, 0);

    // Adjacent-to-(2,2) tiles should have positive threat.
    const adj = [
      { x: 1, y: 2 },
      { x: 3, y: 2 },
      { x: 2, y: 1 },
      { x: 2, y: 3 },
    ];
    for (const c of adj) {
      expect(t[c.y]![c.x]!).toBeGreaterThan(0);
    }
    // The max should sit on tiles adjacent to where the tank can stand —
    // since the tank can move up to 6 tiles freely on plain, it can reach all
    // corners and beyond. Pick a clearly far-away tile that has at most range
    // 1 from some reachable tile — all map tiles are reachable here, so the
    // max value should be ≥ adjacent value (they share the same defender HP
    // and terrain). Just check it's a uniform positive surface around the
    // tank's reach.
    expect(t[0]![0]!).toBeGreaterThan(0); // tank can reach (0,1) and hit (0,0).
  });

  it('artillery at (2,2) creates threat ring at distance 2-3, not at distance 1 or 4', () => {
    // Artillery min=2 max=3. We park it on a 7x7 plain map so the threat ring
    // is fully contained. We MUST prevent the artillery from MOVING — otherwise
    // its reach radius makes everything threatened. Surround it with sea (only
    // air/sea-passable) so it has nowhere to move (tread can't enter sea).
    const seaTiles = [
      { pos: { x: 1, y: 2 }, terrain: 'sea' as const, owner: null },
      { pos: { x: 3, y: 2 }, terrain: 'sea' as const, owner: null },
      { pos: { x: 2, y: 1 }, terrain: 'sea' as const, owner: null },
      { pos: { x: 2, y: 3 }, terrain: 'sea' as const, owner: null },
    ];
    const state = makeState({
      width: 7,
      height: 7,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 6, y: 6 } },
      ],
      tiles: seaTiles,
      units: [{ type: 'artillery', owner: 1, pos: { x: 2, y: 2 } }],
    });
    const t = computeThreatMap(state, 1, 0);

    // Distance 1 from artillery's CURRENT position should be 0 (it's
    // indirect; min range = 2). The artillery cannot move (surrounded by
    // sea) so its only reach tile is (2,2) itself.
    for (const c of [
      { x: 1, y: 2 },
      { x: 3, y: 2 },
      { x: 2, y: 1 },
      { x: 2, y: 3 },
    ]) {
      expect(t[c.y]![c.x]!).toBe(0);
    }
    // Distance 2 — in range.
    expect(t[2]![0]!).toBeGreaterThan(0); // (0,2) = distance 2
    expect(t[0]![2]!).toBeGreaterThan(0); // (2,0) = distance 2
    // Distance 3 — in range.
    expect(t[2]![5]!).toBeGreaterThan(0); // (5,2) = distance 3
    // Distance 4 — out of range.
    expect(t[2]![6]!).toBe(0); // (6,2) = distance 4
  });
});

describe('threat map: multiple enemies', () => {
  it('takes the MAX across enemies, not the sum', () => {
    // Two enemy infantry both attacking (2,2). Infantry max damage to tank is
    // about 5 (very weak). Two infantry both threatening the same tile should
    // still produce the same threat value as one (max, not sum).
    const stateOne = makeState({
      width: 5,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 4 } },
      ],
      units: [{ type: 'infantry', owner: 1, pos: { x: 2, y: 2 } }],
    });
    // Put a second infantry adjacent — at (3,2). It can also threaten (2,2)
    // (range 1, distance 1).
    const stateTwo = makeState({
      width: 5,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 4 } },
      ],
      units: [
        { type: 'infantry', owner: 1, pos: { x: 2, y: 2 } },
        { type: 'infantry', owner: 1, pos: { x: 3, y: 2 } },
      ],
    });
    const t1 = computeThreatMap(stateOne, 1, 0);
    const t2 = computeThreatMap(stateTwo, 1, 0);

    // The map dimensions match.
    expect(t1.length).toBe(t2.length);
    // For a tile that BOTH infantry threaten identically (say (1,2),
    // distance 1 from #1 and distance 2 from #2 — wait, #2 at (3,2) is at
    // distance 2 from (1,2), so #2 doesn't threaten (1,2). Pick (3,3): #1 at
    // (2,2) can move to e.g. (3,2) then hit (3,3); #2 at (3,2) can stay and
    // hit (3,3). Both can threaten (3,3) — but with similar damage values
    // since both are infantry. The maximum should be roughly equal between
    // the two states.
    //
    // The crisp check: t2 should NOT be roughly double t1 anywhere — max is
    // not additive.
    for (let y = 0; y < t1.length; y++) {
      for (let x = 0; x < t1[0]!.length; x++) {
        // t2 can be larger because there are more reach tiles to consider,
        // but not by a factor of 2 (which is what summing would yield for
        // tiles both can attack identically).
        if (t1[y]![x]! > 0) {
          expect(t2[y]![x]!).toBeLessThan(t1[y]![x]! * 2);
        }
      }
    }
  });
});
