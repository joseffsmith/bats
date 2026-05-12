// Phase 5: value-map precomputation tests.
//
// The value map is a per-tile strategic priority signal. It's the sum of:
//   - HQ-attraction (high near enemy HQ),
//   - capturable-tile bonus (unowned capturable +3),
//   - chokepoint bonus (low passable-neighbour count).

import { describe, expect, it } from 'vitest';
import './test-helpers';

import { makeState } from './test-helpers';
import { computeValueMap } from '../src/engine/ai/threatMap';

describe('value map: HQ attraction', () => {
  it('valueMap is highest within 1 tile of enemy HQ', () => {
    const state = makeState({
      width: 6,
      height: 6,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 5 } },
      ],
    });
    const v = computeValueMap(state, 0);

    // Enemy HQ is (5,5). Tiles at distance 0,1 around it should outscore
    // distant tiles.
    const atHq = v[5]![5]!;
    const adj = v[5]![4]!;
    const far = v[0]![1]!; // ~distance 9 from enemy HQ
    expect(atHq).toBeGreaterThan(adj);
    expect(adj).toBeGreaterThan(far);
  });
});

describe('value map: capturable bonus', () => {
  it('rewards unowned capturable tiles', () => {
    // Two adjacent plain tiles, then one neutral city sitting beside them.
    // The city should score higher than the plain at the same distance from
    // the enemy HQ.
    const state = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 5, y: 1 } },
      ],
      tiles: [{ pos: { x: 2, y: 1 }, terrain: 'city', owner: null }],
    });
    const v = computeValueMap(state, 0);

    // Both (2,1) (city) and (2,0) (plain) are equidistant from enemy HQ at
    // (5,1): manhattan = 3 and 4 respectively. The neutral city at (2,1)
    // gets a +3 capturable bonus on top of the HQ attraction.
    expect(v[1]![2]!).toBeGreaterThan(v[0]![2]!);
    // And the city tile beats an equidistant plain tile.
    const plainAtSameDist = v[0]![3]!; // (3,0) -> distance 3 from (5,1)
    const cityAtSameDist = v[1]![2]!; // (2,1) -> distance 3 from (5,1)
    expect(cityAtSameDist).toBeGreaterThan(plainAtSameDist);
  });

  it('does not reward a capturable already owned by forPlayer', () => {
    const stateNeutral = makeState({
      width: 4,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 3, y: 1 } },
      ],
      tiles: [{ pos: { x: 1, y: 1 }, terrain: 'city', owner: null }],
    });
    const stateOwned = makeState({
      width: 4,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 3, y: 1 } },
      ],
      tiles: [{ pos: { x: 1, y: 1 }, terrain: 'city', owner: 0 }],
    });
    const vNeutral = computeValueMap(stateNeutral, 0);
    const vOwned = computeValueMap(stateOwned, 0);
    // The neutral city should be more valuable than the same city already in
    // our possession.
    expect(vNeutral[1]![1]!).toBeGreaterThan(vOwned[1]![1]!);
  });
});
