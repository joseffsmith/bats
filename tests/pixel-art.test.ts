// Pure-data guards for the hand-authored unit sprites (no canvas — runs in the
// node env). These are the objective bars the art has to clear so a future edit
// can't quietly ship a malformed or unreadable sprite:
//
//   • structural — 16×16, only known chars (dimension + palette contract);
//   • team read — ≥25% of opaque pixels come from the team ramp (A–D), so the
//     body actually looks like whose unit it is (Advance-Wars style);
//   • not-a-blob — ≥3 distinct non-transparent chars (real shading, not a slab);
//   • distinct — every pair of silhouettes differs by ≥ SILHOUETTE_FLOOR cells.
//
// SILHOUETTE_FLOOR: the plan's hard minimum is 12. The current roster's *worst*
// pair (battleship/carrier) sits at 23, so we set the enforced floor to 18 — a
// real bar with headroom for minor future tweaks, not a rubber stamp at 12.

import { describe, expect, it } from 'vitest';
import { UNIT_GRIDS } from '../src/renderer/assets/pixel-art/units/index';
import { SOOT_DECAL } from '../src/renderer/assets/pixel-art/soot';
import {
  validateGrid,
  teamPixelRatio,
  distinctChars,
  silhouetteDistance,
} from '../src/renderer/assets/pixel-art/validate';
import type { UnitType } from '../src/engine/core/types';

const TYPES = Object.keys(UNIT_GRIDS) as UnitType[];
const SILHOUETTE_FLOOR = 18;
const MIN_TEAM_RATIO = 0.25;
const MIN_DISTINCT_CHARS = 3;

describe('pixel-art: structure', () => {
  it('covers all 14 unit types', () => {
    expect(TYPES).toHaveLength(14);
  });

  it.each(TYPES)('%s is a valid 16×16 grid of known chars', (type) => {
    expect(validateGrid(type, UNIT_GRIDS[type])).toEqual([]);
  });

  it('the shared soot decal is itself a valid grid', () => {
    expect(validateGrid('soot', SOOT_DECAL)).toEqual([]);
  });
});

describe('pixel-art: readability', () => {
  it.each(TYPES)('%s is ≥25%% team-coloured', (type) => {
    expect(teamPixelRatio(UNIT_GRIDS[type])).toBeGreaterThanOrEqual(MIN_TEAM_RATIO);
  });

  it.each(TYPES)('%s uses ≥3 distinct non-transparent chars', (type) => {
    expect(distinctChars(UNIT_GRIDS[type]).size).toBeGreaterThanOrEqual(MIN_DISTINCT_CHARS);
  });
});

describe('pixel-art: silhouettes are distinct', () => {
  it(`every pair differs by ≥${SILHOUETTE_FLOOR} cells`, () => {
    const offenders: string[] = [];
    for (let i = 0; i < TYPES.length; i++) {
      for (let j = i + 1; j < TYPES.length; j++) {
        const a = TYPES[i]!;
        const b = TYPES[j]!;
        const d = silhouetteDistance(UNIT_GRIDS[a], UNIT_GRIDS[b]);
        if (d < SILHOUETTE_FLOOR) offenders.push(`${a}/${b}=${d}`);
      }
    }
    expect(offenders, `pairs below floor: ${offenders.join(', ')}`).toEqual([]);
  });
});
