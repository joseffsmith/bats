// Aggregator: every terrain's authored PixelGrid, keyed by TerrainType.
//
// Single source of truth for the terrain bake (../../terrain.ts) and the
// validators (tests/terrain-art.test.ts). Keeping it a plain Record makes
// "is every TerrainType covered?" a compile-time check.

import type { TerrainType } from '../../../../engine/core/types';
import type { PixelGrid } from '../types';

import { plain } from './plain';
import { road } from './road';
import { forest } from './forest';
import { mountain } from './mountain';
import { sea } from './sea';
import { city } from './city';
import { hq } from './hq';
import { factory } from './factory';

export const TERRAIN_GRIDS: Record<TerrainType, PixelGrid> = {
  plain,
  road,
  forest,
  mountain,
  sea,
  city,
  hq,
  factory,
};

/** Capturable terrains — these bake per owner ∈ {neutral, 0, 1}; their grids
 *  carry team-ramp accent cells. Everything else bakes once (owner-independent
 *  and must contain no team cells). */
export const OWNED_TERRAIN: ReadonlySet<TerrainType> = new Set(['city', 'hq', 'factory']);
