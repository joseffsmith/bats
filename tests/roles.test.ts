// Phase 5: role assignment tests.
//
// Precedence: defender > capturer > support > frontline.
// See `src/engine/ai/roles.ts` for the documented rationale.

import { describe, expect, it } from 'vitest';
import './test-helpers';

import { makeState } from './test-helpers';
import { assignRoles } from '../src/engine/ai/roles';
import { computeThreatMap } from '../src/engine/ai/threatMap';

describe('role assignment', () => {
  it('low-HP unit → support, regardless of other criteria (far from HQ + no threat)', () => {
    // Tank at low HP, far from HQ, no enemies. With no threat to HQ the
    // defender branch never fires; with no nearby capturable for an infantry
    // the capturer branch is skipped (tank isn't infantry anyway). HP < 50
    // sends it to support.
    const state = makeState({
      width: 10,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 9, y: 4 } },
      ],
      units: [{ type: 'tank', owner: 0, pos: { x: 8, y: 3 }, hp: 30 }],
    });
    const t = computeThreatMap(state, 1, 0);
    const roles = assignRoles(state, 0, t);
    expect([...roles.values()][0]).toBe('support');
  });

  it('infantry near unowned city → capturer', () => {
    const state = makeState({
      width: 8,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 2 } },
        { owner: 1, pos: { x: 7, y: 2 } },
      ],
      tiles: [{ pos: { x: 4, y: 2 }, terrain: 'city', owner: null }],
      // Infantry at full HP, 2 tiles from the neutral city → within
      // CAPTURER_PROXIMITY=4. Far from own HQ.
      units: [{ type: 'infantry', owner: 0, pos: { x: 3, y: 2 } }],
    });
    const t = computeThreatMap(state, 1, 0);
    const roles = assignRoles(state, 0, t);
    expect([...roles.values()][0]).toBe('capturer');
  });

  it('tank near own HQ when enemy artillery in range → defender', () => {
    // Enemy artillery directly threatens our HQ tile from distance 2-3.
    // Place artillery at (3,2); HQ at (1,2) — distance 2, within range
    // [2,3]. Tank at (2,2) is within 4 of HQ. Defender role should win
    // over frontline.
    const state = makeState({
      width: 6,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 1, y: 2 } },
        { owner: 1, pos: { x: 5, y: 2 } },
      ],
      units: [
        { type: 'tank', owner: 0, pos: { x: 2, y: 2 } },
        { type: 'artillery', owner: 1, pos: { x: 3, y: 2 } },
      ],
    });
    const t = computeThreatMap(state, 1, 0);
    expect(t[2]![1]!).toBeGreaterThan(0); // HQ tile threatened
    const roles = assignRoles(state, 0, t);
    const tankId = Object.values(state.units).find((u) => u.type === 'tank')!.id;
    expect(roles.get(tankId)).toBe('defender');
  });

  it('everything else → frontline', () => {
    // Healthy tank, no HQ threat, no capturable nearby — falls through to
    // frontline.
    const state = makeState({
      width: 8,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 7, y: 4 } },
      ],
      units: [{ type: 'tank', owner: 0, pos: { x: 4, y: 2 } }],
    });
    const t = computeThreatMap(state, 1, 0);
    const roles = assignRoles(state, 0, t);
    expect([...roles.values()][0]).toBe('frontline');
  });

  it('artillery is always support (even at full HP)', () => {
    const state = makeState({
      width: 8,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 7, y: 4 } },
      ],
      units: [{ type: 'artillery', owner: 0, pos: { x: 4, y: 2 } }],
    });
    const t = computeThreatMap(state, 1, 0);
    const roles = assignRoles(state, 0, t);
    expect([...roles.values()][0]).toBe('support');
  });
});
