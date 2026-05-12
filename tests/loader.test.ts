// Phase 2 loader tests.
//
// Two kinds of coverage:
//   1. Happy-path — every shipped JSON loads cleanly and the resulting tables
//      cover every enum value in the engine.
//   2. Negative — hand-crafted broken JSON triggers the right error message,
//      with the JSON path included.

import { describe, expect, it } from 'vitest';
import './test-helpers';

import unitsJson from '../src/data/units.json';
import terrainJson from '../src/data/terrain.json';
import damageJson from '../src/data/damage.json';
import aiWeightsJson from '../src/data/ai-weights.json';
import duelJson from '../src/data/maps/duel.json';
import crossroadsJson from '../src/data/maps/crossroads.json';

import {
  loadUnits,
  loadTerrain,
  loadDamage,
  loadAIWeights,
  loadMap,
} from '../src/engine/data/loader';
import type { TerrainType, UnitType } from '../src/engine/core/types';

const UNIT_TYPES: UnitType[] = ['infantry', 'recon', 'tank', 'artillery', 'copter'];
const TERRAIN_TYPES: TerrainType[] = [
  'plain',
  'road',
  'forest',
  'mountain',
  'sea',
  'city',
  'hq',
  'factory',
];

describe('loader: happy path', () => {
  it('loadUnits parses all shipped unit definitions', () => {
    const units = loadUnits(unitsJson);
    for (const t of UNIT_TYPES) {
      expect(units[t]).toBeDefined();
      expect(units[t].cost).toBeGreaterThan(0);
      expect(units[t].move).toBeGreaterThan(0);
    }
    expect(units.infantry.canCapture).toBe(true);
    expect(units.tank.canCapture).toBe(false);
    expect(units.artillery.indirect).toBe(true);
  });

  it('loadTerrain covers every TerrainType, with null → Infinity', () => {
    const terrain = loadTerrain(terrainJson);
    for (const t of TERRAIN_TYPES) {
      expect(terrain[t]).toBeDefined();
    }
    // Sea is impassable to foot/wheel/tread.
    expect(terrain.sea.moveCost.foot).toBe(Infinity);
    expect(terrain.sea.moveCost.tread).toBe(Infinity);
    expect(terrain.plain.moveCost.sea).toBe(Infinity);
    // Mountain blocks wheel/tread but not foot.
    expect(terrain.mountain.moveCost.wheel).toBe(Infinity);
    expect(terrain.mountain.moveCost.foot).toBe(2);
    // HQ defense is 4.
    expect(terrain.hq.defenseStars).toBe(4);
  });

  it('loadDamage covers every (attacker, defender) pair', () => {
    const damage = loadDamage(damageJson);
    for (const a of UNIT_TYPES) {
      expect(damage[a]).toBeDefined();
      for (const d of UNIT_TYPES) {
        expect(typeof damage[a][d]).toBe('number');
      }
    }
    // Spot-check tables match PLAN.md.
    expect(damage.tank.tank).toBe(55);
    expect(damage.artillery.copter).toBe(65);
    expect(damage.infantry.tank).toBe(5);
  });

  it('loadAIWeights returns the default weights', () => {
    const w = loadAIWeights(aiWeightsJson);
    expect(w.damageDealt).toBe(1.0);
    expect(w.capture).toBe(1.5);
    expect(w.objective).toBe(0.6);
  });

  it('loaded tables are frozen', () => {
    const units = loadUnits(unitsJson);
    expect(Object.isFrozen(units)).toBe(true);
    expect(Object.isFrozen(units.infantry)).toBe(true);
    // Strict-mode mutation of a frozen object throws TypeError.
    expect(() => {
      units.infantry.cost = 99;
    }).toThrow();
    expect(units.infantry.cost).toBe(1000);
  });

  it('damage matrix is consistent with units table', () => {
    const units = loadUnits(unitsJson);
    const damage = loadDamage(damageJson, units);
    for (const a of UNIT_TYPES) {
      for (const d of UNIT_TYPES) {
        expect(damage[a][d]).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('loader: maps', () => {
  it('duel.json loads and HQ coords match the H tiles in the grid', () => {
    const state = loadMap(duelJson);
    expect(state.map).toHaveLength(8);
    expect(state.map[0]).toHaveLength(12);

    const hq0 = state.players[0].hq;
    const hq1 = state.players[1].hq;
    expect(state.map[hq0.y]![hq0.x]!.terrain).toBe('hq');
    expect(state.map[hq0.y]![hq0.x]!.owner).toBe(0);
    expect(state.map[hq1.y]![hq1.x]!.terrain).toBe('hq');
    expect(state.map[hq1.y]![hq1.x]!.owner).toBe(1);

    // Per the suggested format: there's at least one neutral city.
    let cityCount = 0;
    let factoryCount = 0;
    for (const row of state.map) {
      for (const tile of row) {
        if (tile.terrain === 'city' && tile.owner === null) cityCount += 1;
        if (tile.terrain === 'factory') factoryCount += 1;
      }
    }
    expect(cityCount).toBe(4); // four neutral cities
    expect(factoryCount).toBe(2); // one factory per player

    // Starting units are present.
    expect(Object.values(state.units)).toHaveLength(2);
  });

  it('crossroads.json validates and has more strategic structure than duel', () => {
    const state = loadMap(crossroadsJson);
    expect(state.map).toHaveLength(10);
    expect(state.map[0]).toHaveLength(16);

    // Two factories per side, six neutral cities, central road crossroads.
    let p0Factories = 0;
    let p1Factories = 0;
    let neutralCities = 0;
    let roads = 0;
    let forests = 0;
    for (const row of state.map) {
      for (const tile of row) {
        if (tile.terrain === 'factory' && tile.owner === 0) p0Factories += 1;
        if (tile.terrain === 'factory' && tile.owner === 1) p1Factories += 1;
        if (tile.terrain === 'city' && tile.owner === null) neutralCities += 1;
        if (tile.terrain === 'road') roads += 1;
        if (tile.terrain === 'forest') forests += 1;
      }
    }
    expect(p0Factories).toBe(2);
    expect(p1Factories).toBe(2);
    expect(neutralCities).toBeGreaterThanOrEqual(4);
    expect(roads).toBeGreaterThan(0);
    expect(forests).toBeGreaterThan(0);
  });

  it('starting state is "fresh": turn 1, P0 to move, no winner', () => {
    const state = loadMap(duelJson);
    expect(state.turn).toBe(1);
    expect(state.currentPlayer).toBe(0);
    expect(state.winner).toBeNull();
    expect(state.phase).toBe('idle');
  });
});

describe('loader: validation errors', () => {
  it('reports a missing field with its JSON path', () => {
    const bad = JSON.parse(JSON.stringify(unitsJson)) as Array<Record<string, unknown>>;
    delete bad[0]!.cost;
    expect(() => loadUnits(bad)).toThrow(/units\[0\]\.cost/);
  });

  it('reports a wrong-typed field', () => {
    const bad = JSON.parse(JSON.stringify(unitsJson)) as Array<Record<string, unknown>>;
    bad[0]!.cost = 'free';
    expect(() => loadUnits(bad)).toThrow(/units\[0\]\.cost.*number/);
  });

  it('reports an unknown unit type in the damage matrix', () => {
    const bad = JSON.parse(JSON.stringify(damageJson)) as Record<string, unknown>;
    (bad as Record<string, unknown>).submarine = { infantry: 50 };
    expect(() => loadDamage(bad)).toThrow(/damage\.submarine/);
  });

  it('reports a missing damage cell', () => {
    const bad = JSON.parse(JSON.stringify(damageJson)) as Record<string, Record<string, number>>;
    delete bad.tank!.copter;
    expect(() => loadDamage(bad)).toThrow(/damage\.tank\.copter/);
  });

  it('rejects a map whose declared HQ coord disagrees with the tile grid', () => {
    const bad = JSON.parse(JSON.stringify(duelJson)) as Record<string, unknown>;
    (bad.players as { '0': { hq: { x: number; y: number } } })['0'].hq = { x: 0, y: 0 };
    expect(() => loadMap(bad)).toThrow(/map\.players\.0\.hq/);
  });

  it('rejects a map whose row length disagrees with declared width', () => {
    const bad = JSON.parse(JSON.stringify(duelJson)) as Record<string, unknown>;
    (bad.tiles as string[])[0] = 'short';
    expect(() => loadMap(bad)).toThrow(/map\.tiles\[0\]/);
  });

  it('rejects a map with an unknown legend symbol', () => {
    const bad = JSON.parse(JSON.stringify(duelJson)) as Record<string, unknown>;
    (bad.tiles as string[])[0] = 'X' + (bad.tiles as string[])[0]!.slice(1);
    expect(() => loadMap(bad)).toThrow(/symbol "X"/);
  });

  it('rejects an AI-weights file with a negative weight', () => {
    expect(() => loadAIWeights({ ...aiWeightsJson, damageDealt: -1 })).toThrow(
      /aiWeights\.damageDealt/,
    );
  });

  it('rejects an AI-weights file with an unknown key', () => {
    expect(() => loadAIWeights({ ...aiWeightsJson, mystery: 1 })).toThrow(
      /aiWeights\.mystery/,
    );
  });

  it('rejects two units stacked on the same tile', () => {
    const bad = JSON.parse(JSON.stringify(duelJson)) as Record<string, unknown>;
    const units = bad.units as Array<{ type: string; owner: number; pos: { x: number; y: number } }>;
    units.push({
      type: 'infantry',
      owner: 0,
      pos: { x: units[0]!.pos.x, y: units[0]!.pos.y },
    });
    expect(() => loadMap(bad)).toThrow(/already occupied/);
  });
});
