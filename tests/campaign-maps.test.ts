// Campaign boards: schema, lesson shape, registry wiring, and a seeded
// AI-vs-AI smoke run per map.
//
// The smoke runs are the honest check that a teaching board is playable at
// all: two personas fight it out through the real engine, and the match must
// reach a winner well inside the mission's own day budget rather than
// deadlocking on terrain the AI cannot cross.

import { describe, expect, it } from 'vitest';
import c1Map from '../src/data/maps/c1_first_strike.json';
import c2Map from '../src/data/maps/c2_flag_country.json';
import c3Map from '../src/data/maps/c3_war_economy.json';
import c4Map from '../src/data/maps/c4_high_ground.json';
import c5Map from '../src/data/maps/c5_black_pines.json';
import campaignJson from '../src/data/campaign.json';
import { loadMap } from '../src/engine/data/loader';
import { setLogEnabled } from '../src/engine/core/logger';
import type { GameState, PlayerId, TerrainType, UnitType } from '../src/engine/core/types';
import { runMatch } from '../src/cli/run-match';
import {
  ALL_MAP_NAMES,
  CAMPAIGN_MAP_NAMES,
  DEFAULT_MAP,
  MAPS,
  MAP_NAMES,
  mapJson,
  mapLabel,
  resolveAnyMapName,
  resolveMapName,
} from '../src/renderer/maps';
import { loadCampaign } from '../src/campaign/loader';

setLogEnabled('engine', false);
setLogEnabled('ai', false);
setLogEnabled('match', false);

type Board = {
  name: string;
  json: unknown;
  /** Personas for the smoke run — p0 is the seat the player takes. */
  p0: string;
  p1: string;
};

const BOARDS: ReadonlyArray<Board> = [
  { name: 'c1_first_strike', json: c1Map, p0: 'aggressor', p1: 'turtle' },
  { name: 'c2_flag_country', json: c2Map, p0: 'aggressor', p1: 'balanced' },
  { name: 'c3_war_economy', json: c3Map, p0: 'aggressor', p1: 'economist' },
  { name: 'c4_high_ground', json: c4Map, p0: 'balanced', p1: 'aggressor' },
  { name: 'c5_black_pines', json: c5Map, p0: 'aggressor', p1: 'balanced' },
];

/** A generous cap: every board above resolves inside ~25 plies, so 120 leaves
 *  an order of magnitude of slack for AI tuning drift. */
const MAX_TURNS = 120;

function countTerrain(state: GameState, t: TerrainType): number {
  let n = 0;
  for (const row of state.map) for (const tile of row) if (tile.terrain === t) n += 1;
  return n;
}

function countOwnedTerrain(
  state: GameState,
  t: TerrainType,
  owner: PlayerId | null,
): number {
  let n = 0;
  for (const row of state.map) {
    for (const tile of row) if (tile.terrain === t && tile.owner === owner) n += 1;
  }
  return n;
}

function unitsOf(state: GameState, owner: PlayerId): UnitType[] {
  return Object.values(state.units)
    .filter((u) => u.owner === owner)
    .map((u) => u.type)
    .sort();
}

describe('campaign maps — schema', () => {
  for (const b of BOARDS) {
    it(`${b.name} loads through the engine loader`, () => {
      const state = loadMap(b.json);
      expect(state.map.length).toBeGreaterThan(0);
      expect(state.players[0].hq).toBeDefined();
      expect(state.players[1].hq).toBeDefined();
      expect(countTerrain(state, 'hq')).toBe(2);
      expect(state.winner).toBeNull();
      expect(state.turn).toBe(1);
      // Both sides must own something to fight with, or the first checkWinner
      // ends the mission before it starts.
      expect(unitsOf(state, 0).length).toBeGreaterThan(0);
      expect(unitsOf(state, 1).length).toBeGreaterThan(0);
    });

    it(`${b.name} is portrait and fits a 390px phone at 48px tiles`, () => {
      const state = loadMap(b.json);
      const width = state.map[0]!.length;
      const height = state.map.length;
      expect(width).toBeGreaterThanOrEqual(6);
      expect(width).toBeLessThanOrEqual(8);
      expect(height).toBeGreaterThan(width);
      expect(Math.floor(390 / width)).toBeGreaterThanOrEqual(48);
      for (const row of state.map) expect(row.length).toBe(width);
    });
  }
});

describe('campaign maps — lesson shape', () => {
  it('c1 teaches move + attack only: no factories, no cities', () => {
    const state = loadMap(c1Map);
    expect(countTerrain(state, 'factory')).toBe(0);
    expect(countTerrain(state, 'city')).toBe(0);
    expect(unitsOf(state, 0)).toEqual(['infantry', 'tank', 'tank']);
    expect(unitsOf(state, 1)).toEqual(['infantry', 'infantry']);
    // One defender is pre-wounded so a single tank round is a clean kill —
    // the first attack a beginner makes should feel decisive.
    const wounded = Object.values(state.units).filter((u) => u.owner === 1 && u.hp < 100);
    expect(wounded).toHaveLength(1);
  });

  it('c2 teaches capture: three neutral cities and a reachable HQ', () => {
    const state = loadMap(c2Map);
    expect(countOwnedTerrain(state, 'city', null)).toBe(3);
    expect(countTerrain(state, 'factory')).toBe(0);
    expect(unitsOf(state, 0)).toEqual(['infantry', 'infantry', 'infantry', 'tank']);
    expect(unitsOf(state, 1)).toEqual(['infantry', 'recon']);
    // The road spine runs the length of the board so the lesson ("roads are
    // cheap") is actually available.
    expect(countTerrain(state, 'road')).toBeGreaterThanOrEqual(8);
  });

  it('c3 teaches economy: a factory each, four neutral cities, seed funds', () => {
    const state = loadMap(c3Map);
    expect(countOwnedTerrain(state, 'factory', 0)).toBe(1);
    expect(countOwnedTerrain(state, 'factory', 1)).toBe(1);
    expect(countOwnedTerrain(state, 'city', null)).toBe(4);
    expect(state.players[0].funds).toBe(3000);
    expect(unitsOf(state, 0)).toEqual(['infantry']);
    // The player must not be able to out-spend the lesson on turn one.
    expect(state.players[0].funds).toBeLessThan(7000);
  });

  it('c4 teaches terrain: a mountain ridge with a two-tile road pass', () => {
    const state = loadMap(c4Map);
    expect(countTerrain(state, 'mountain')).toBeGreaterThanOrEqual(10);
    // Find the rows that are entirely ridge-or-pass and check the gap width.
    const ridgeRows = state.map.filter((row) =>
      row.every((t) => t.terrain === 'mountain' || t.terrain === 'road'),
    );
    expect(ridgeRows.length).toBeGreaterThanOrEqual(2);
    for (const row of ridgeRows) {
      expect(row.filter((t) => t.terrain === 'road')).toHaveLength(2);
    }
    // The player's side gets the indirect unit; the opponent brings armour.
    expect(unitsOf(state, 0)).toContain('artillery');
    expect(unitsOf(state, 1).filter((t) => t === 'tank').length).toBeGreaterThanOrEqual(2);
    expect(unitsOf(state, 1)).not.toContain('artillery');
  });

  it('c5 teaches fog: forest belts, a recon, and one city as a vision anchor', () => {
    const state = loadMap(c5Map);
    expect(countTerrain(state, 'forest')).toBeGreaterThanOrEqual(12);
    expect(countOwnedTerrain(state, 'city', null)).toBe(1);
    expect(unitsOf(state, 0)).toEqual(['infantry', 'infantry', 'recon', 'tank']);
    // Fog is a mission-level decision, not a map field — the board itself is
    // playable in the clear.
    const m5 = loadCampaign(campaignJson).find((m) => m.map === 'c5_black_pines');
    expect(m5?.fog).toBe(true);
  });
});

describe('campaign maps — registry', () => {
  it('registers every campaign board without polluting the skirmish list', () => {
    for (const b of BOARDS) {
      expect(CAMPAIGN_MAP_NAMES).toContain(b.name);
      expect(MAP_NAMES).not.toContain(b.name);
      expect(ALL_MAP_NAMES).toContain(b.name);
      expect(MAPS[b.name as keyof typeof MAPS]).toBeTruthy();
    }
    expect(CAMPAIGN_MAP_NAMES).toHaveLength(5);
    expect(MAP_NAMES).toHaveLength(6);
    expect(ALL_MAP_NAMES).toHaveLength(11);
  });

  it('the skirmish resolver still refuses campaign names', () => {
    for (const name of CAMPAIGN_MAP_NAMES) {
      expect(resolveMapName(name)).toBe(DEFAULT_MAP);
    }
    for (const name of MAP_NAMES) expect(resolveMapName(name)).toBe(name);
  });

  it('the campaign-aware resolver accepts both families', () => {
    for (const name of ALL_MAP_NAMES) {
      expect(resolveAnyMapName(name)).toBe(name);
      expect(mapJson(name)).toBeTruthy();
      expect(loadMap(mapJson(name))).toBeTruthy();
    }
    expect(resolveAnyMapName('atlantis')).toBeNull();
    expect(resolveAnyMapName(null)).toBeNull();
    expect(mapJson('atlantis')).toBeNull();
  });

  it('labels campaign boards for the mission list', () => {
    expect(mapLabel('c1_first_strike')).toBe('C1 First Strike');
    expect(mapLabel('duel')).toBe('Duel');
  });

  it('every mission in the campaign points at a registered board', () => {
    const used = loadCampaign(campaignJson).map((m) => m.map);
    expect(used).toEqual([...CAMPAIGN_MAP_NAMES]);
  });
});

describe('campaign maps — AI smoke', () => {
  for (const b of BOARDS) {
    it(
      `${b.name} resolves to a winner with ${b.p0} vs ${b.p1}`,
      async () => {
        for (const seed of [1, 7]) {
          const result = await runMatch({
            mapName: b.name,
            mapJson: b.json,
            maxTurns: MAX_TURNS,
            seed,
            p0: { name: b.p0 },
            p1: { name: b.p1 },
            writeLog: false,
          });
          expect(result.winner, `${b.name} seed ${seed} deadlocked`).not.toBeNull();
          expect(result.turns).toBeLessThan(MAX_TURNS);
          // A campaign board that only resolves after 40 days is not a lesson.
          expect(Math.ceil(result.turns / 2)).toBeLessThanOrEqual(30);
        }
      },
      30_000,
    );
  }

  it('every board resolves well inside its mission day limit for a competent side', async () => {
    const missions = loadCampaign(campaignJson);
    for (const b of BOARDS) {
      const mission = missions.find((m) => m.map === b.name)!;
      const result = await runMatch({
        mapName: b.name,
        mapJson: b.json,
        maxTurns: MAX_TURNS,
        seed: 3,
        p0: { name: b.p0 },
        p1: { name: b.p1 },
        writeLog: false,
      });
      expect(result.winner).not.toBeNull();
      expect(
        Math.ceil(result.turns / 2),
        `${b.name} outlasts its own day limit`,
      ).toBeLessThanOrEqual(mission.defeat.dayLimit);
    }
  }, 60_000);
});
