// Aggregator: every unit's authored PixelGrid, keyed by UnitType.
//
// This is the single source of truth the bake pipeline (sprites.ts) and the
// validators (tests/pixel-art.test.ts) both consume. Keeping it a plain record
// means "is every UnitType covered?" is a compile-time check — the Record type
// won't satisfy TypeScript unless all 14 keys are present.

import type { UnitType } from '../../../../engine/core/types';
import type { PixelGrid } from '../types';

import { infantry } from './infantry';
import { recon } from './recon';
import { tank } from './tank';
import { artillery } from './artillery';
import { copter } from './copter';
import { transport } from './transport';
import { fighter } from './fighter';
import { bomber } from './bomber';
import { battleship } from './battleship';
import { cruiser } from './cruiser';
import { aatank } from './aatank';
import { lander } from './lander';
import { submarine } from './submarine';
import { carrier } from './carrier';

export const UNIT_GRIDS: Record<UnitType, PixelGrid> = {
  infantry,
  recon,
  tank,
  artillery,
  copter,
  transport,
  fighter,
  bomber,
  battleship,
  cruiser,
  aatank,
  lander,
  submarine,
  carrier,
};
