// Phase 1 inline data tables.
//
// IMPORTANT: Phase 2 will replace these tables with JSON loaded from
// `/src/data/*.json`. For now they live here so the engine has no runtime
// dependency on the data files (which already exist as scaffolding stubs but
// are not yet validated or wired up). All values come straight from PLAN.md.

import type { MovementClass, TerrainType, UnitType } from './core/types';

export type UnitStats = {
  cost: number;
  move: number;
  movementClass: MovementClass;
  /** Inclusive min..max attack range in tiles (Manhattan). */
  minRange: number;
  maxRange: number;
  /** Indirect units cannot counter, and cannot move-and-attack the same turn. */
  indirect: boolean;
  /** Only infantry can capture. */
  canCapture: boolean;
};

export const UNITS: Record<UnitType, UnitStats> = {
  infantry: {
    cost: 1000,
    move: 3,
    movementClass: 'foot',
    minRange: 1,
    maxRange: 1,
    indirect: false,
    canCapture: true,
  },
  recon: {
    cost: 4000,
    move: 8,
    movementClass: 'wheel',
    minRange: 1,
    maxRange: 1,
    indirect: false,
    canCapture: false,
  },
  tank: {
    cost: 7000,
    move: 6,
    movementClass: 'tread',
    minRange: 1,
    maxRange: 1,
    indirect: false,
    canCapture: false,
  },
  artillery: {
    cost: 6000,
    move: 5,
    movementClass: 'tread',
    minRange: 2,
    maxRange: 3,
    indirect: true,
    canCapture: false,
  },
  copter: {
    cost: 9000,
    move: 6,
    movementClass: 'air',
    minRange: 1,
    maxRange: 1,
    indirect: false,
    canCapture: false,
  },
};

export type TerrainStats = {
  defenseStars: number;
  /** Movement cost per class. Infinity = impassable. */
  moveCost: Record<MovementClass, number>;
};

export const TERRAIN: Record<TerrainType, TerrainStats> = {
  plain: {
    defenseStars: 1,
    moveCost: { foot: 1, wheel: 2, tread: 1, air: 1, sea: Infinity },
  },
  road: {
    defenseStars: 0,
    moveCost: { foot: 1, wheel: 1, tread: 1, air: 1, sea: Infinity },
  },
  forest: {
    defenseStars: 2,
    moveCost: { foot: 1, wheel: 3, tread: 2, air: 1, sea: Infinity },
  },
  mountain: {
    defenseStars: 4,
    moveCost: { foot: 2, wheel: Infinity, tread: Infinity, air: 1, sea: Infinity },
  },
  sea: {
    defenseStars: 0,
    moveCost: { foot: Infinity, wheel: Infinity, tread: Infinity, air: 1, sea: 1 },
  },
  city: {
    defenseStars: 3,
    moveCost: { foot: 1, wheel: 1, tread: 1, air: 1, sea: Infinity },
  },
  hq: {
    defenseStars: 4,
    moveCost: { foot: 1, wheel: 1, tread: 1, air: 1, sea: Infinity },
  },
  factory: {
    defenseStars: 3,
    moveCost: { foot: 1, wheel: 1, tread: 1, air: 1, sea: Infinity },
  },
};

/**
 * Base damage matrix. `DAMAGE[attacker][defender]` is the base % damage a
 * full-HP attacker deals to a 0-stars/full-HP defender.
 */
export const DAMAGE: Record<UnitType, Record<UnitType, number>> = {
  infantry: {
    infantry: 55,
    recon: 12,
    tank: 5,
    artillery: 15,
    copter: 7,
  },
  recon: {
    infantry: 75,
    recon: 35,
    tank: 10,
    artillery: 35,
    copter: 55,
  },
  tank: {
    infantry: 75,
    recon: 85,
    tank: 55,
    artillery: 70,
    copter: 65,
  },
  artillery: {
    infantry: 90,
    recon: 80,
    tank: 70,
    artillery: 75,
    copter: 65,
  },
  copter: {
    infantry: 75,
    recon: 55,
    tank: 25,
    artillery: 65,
    copter: 65,
  },
};

/** Lookup the income-producing terrains. HQ counts for income. */
export const INCOME_TERRAIN: ReadonlyArray<TerrainType> = ['city', 'hq', 'factory'];
export const INCOME_PER_PROPERTY = 1000;

/** Capture progress threshold for ownership flip. */
export const CAPTURE_THRESHOLD = 20;
