// Engine data registry.
//
// Imports the shipped JSON tables and runs them through the validating
// loaders at module init. Re-exports the resulting frozen tables so engine
// consumers can `import { UNITS, TERRAIN, DAMAGE, ... } from '../data'`
// without thinking about the loader.
//
// This module is the single point where the engine reads data from disk
// (via the bundler's resolveJsonModule). Tests can also call the loader
// functions directly for negative-path validation.

import unitsJson from '../../data/units.json';
import terrainJson from '../../data/terrain.json';
import damageJson from '../../data/damage.json';
import aiWeightsJson from '../../data/ai-weights.json';

import {
  loadUnits,
  loadTerrain,
  loadDamage,
  loadAIWeights,
  loadMap,
} from './loader';

import type { TerrainType } from '../core/types';

export const UNITS = loadUnits(unitsJson);
export const TERRAIN = loadTerrain(terrainJson);
export const DAMAGE = loadDamage(damageJson, UNITS);
export const AI_WEIGHTS = loadAIWeights(aiWeightsJson);

/** Income-producing terrains. HQ counts for income. */
export const INCOME_TERRAIN: ReadonlyArray<TerrainType> = Object.freeze([
  'city',
  'hq',
  'factory',
]);
export const INCOME_PER_PROPERTY = 1000;

/** Capture progress threshold for ownership flip. */
export const CAPTURE_THRESHOLD = 20;

export { loadUnits, loadTerrain, loadDamage, loadAIWeights, loadMap };
export type { UnitDef, TerrainDef, AIWeights } from './loader';
