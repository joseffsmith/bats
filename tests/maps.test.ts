// Phase 6 map data tests.
//
// Validates the bundled map files (including the two Phase 6 additions):
// every map's tile grid matches its declared width × height, every HQ
// declared in the players block references an HQ tile owned by that player,
// every tile symbol resolves through the legend, and the resulting GameState
// is internally consistent (no two units on one tile, HQ counts === 2, etc.).

import { describe, expect, it } from 'vitest';
import { loadMap } from '../src/engine/data/loader';
import duelMap from '../src/data/maps/duel.json';
import crossroadsMap from '../src/data/maps/crossroads.json';
import islandHopMap from '../src/data/maps/island_hop.json';
import canyonMap from '../src/data/maps/canyon.json';
import highlandsMap from '../src/data/maps/highlands.json';
import armadaMap from '../src/data/maps/armada.json';
import type { GameState, TerrainType, UnitType } from '../src/engine/core/types';

const ALL_MAPS = [
  { name: 'duel', json: duelMap as unknown },
  { name: 'crossroads', json: crossroadsMap as unknown },
  { name: 'island_hop', json: islandHopMap as unknown },
  { name: 'canyon', json: canyonMap as unknown },
  { name: 'highlands', json: highlandsMap as unknown },
  { name: 'armada', json: armadaMap as unknown },
] as const;

function countTerrain(state: GameState, t: TerrainType): number {
  let n = 0;
  for (const row of state.map) for (const tile of row) if (tile.terrain === t) n += 1;
  return n;
}

describe('map data', () => {
  for (const m of ALL_MAPS) {
    it(`${m.name} loads cleanly`, () => {
      expect(() => loadMap(m.json)).not.toThrow();
    });

    it(`${m.name}: tile grid dimensions match width × height`, () => {
      const state = loadMap(m.json);
      const declared = m.json as { width: number; height: number };
      expect(state.map.length).toBe(declared.height);
      for (const row of state.map) expect(row.length).toBe(declared.width);
    });

    it(`${m.name}: HQs match players block`, () => {
      const state = loadMap(m.json);
      for (const pid of [0, 1] as const) {
        const hq = state.players[pid].hq;
        const tile = state.map[hq.y]?.[hq.x];
        expect(tile?.terrain).toBe('hq');
        expect(tile?.owner).toBe(pid);
      }
      // Exactly two HQ tiles in the grid.
      expect(countTerrain(state, 'hq')).toBe(2);
    });

    it(`${m.name}: starting units are placed in bounds and are unique tiles`, () => {
      const state = loadMap(m.json);
      const seen = new Set<string>();
      for (const u of Object.values(state.units)) {
        const k = `${u.pos.x},${u.pos.y}`;
        expect(seen.has(k)).toBe(false);
        seen.add(k);
        expect(u.pos.x).toBeGreaterThanOrEqual(0);
        expect(u.pos.y).toBeGreaterThanOrEqual(0);
        expect(u.pos.x).toBeLessThan(state.map[0]!.length);
        expect(u.pos.y).toBeLessThan(state.map.length);
      }
    });
  }

  it('island_hop has a central sea band wider than ground bridge', () => {
    const state = loadMap(islandHopMap as unknown);
    // Spot check: column 8 of row 0 is sea.
    expect(state.map[0]![8]!.terrain).toBe('sea');
    expect(state.map[0]![9]!.terrain).toBe('sea');
    // Each player has a factory on their respective side.
    expect(state.map[2]![3]!.terrain).toBe('factory');
    expect(state.map[2]![3]!.owner).toBe(0);
    expect(state.map[2]![14]!.terrain).toBe('factory');
    expect(state.map[2]![14]!.owner).toBe(1);
  });

  it('island_hop ships each player a starting transport on the sea band', () => {
    const state = loadMap(islandHopMap as unknown);
    const transports = Object.values(state.units).filter((u) => u.type === 'transport');
    expect(transports).toHaveLength(2);
    // Each transport sits on a sea tile.
    for (const t of transports) {
      expect(state.map[t.pos.y]![t.pos.x]!.terrain).toBe('sea');
    }
    // One per player.
    const owners = transports.map((t) => t.owner).sort();
    expect(owners).toEqual([0, 1]);
  });

  it('canyon has the mountain spine and roads along the edges', () => {
    const state = loadMap(canyonMap as unknown);
    expect(state.map[0]!.every((t) => t.terrain === 'road')).toBe(true);
    expect(state.map[9]!.every((t) => t.terrain === 'road')).toBe(true);
    // Mountain row in the middle.
    expect(countTerrain(state, 'mountain')).toBeGreaterThanOrEqual(20);
    // Central chokepoint city at (7,5).
    expect(state.map[5]![7]!.terrain).toBe('city');
  });

  it('highlands is fully landlocked with a mountain spine and air-focused roster', () => {
    const state = loadMap(highlandsMap as unknown);
    // No sea tiles anywhere — air superiority matters, naval is out by design.
    expect(countTerrain(state, 'sea')).toBe(0);
    // Substantial mountain spine across the middle.
    expect(countTerrain(state, 'mountain')).toBeGreaterThanOrEqual(15);
    // Both players own two factories each, all inland (no sea-adjacent).
    let p0Factories = 0;
    let p1Factories = 0;
    for (let y = 0; y < state.map.length; y++) {
      for (let x = 0; x < state.map[0]!.length; x++) {
        const t = state.map[y]![x]!;
        if (t.terrain !== 'factory') continue;
        if (t.owner === 0) p0Factories += 1;
        else if (t.owner === 1) p1Factories += 1;
      }
    }
    expect(p0Factories).toBe(2);
    expect(p1Factories).toBe(2);

    // Roster per player: infantry, tank, copter, fighter.
    const countByOwnerType = new Map<string, number>();
    for (const u of Object.values(state.units)) {
      const k = `${u.owner}:${u.type}`;
      countByOwnerType.set(k, (countByOwnerType.get(k) ?? 0) + 1);
    }
    for (const owner of [0, 1] as const) {
      for (const type of ['infantry', 'tank', 'copter', 'fighter'] as UnitType[]) {
        expect(countByOwnerType.get(`${owner}:${type}`)).toBe(1);
      }
    }
  });

  it('armada has wide central sea with at least one coastal factory per side', () => {
    const state = loadMap(armadaMap as unknown);
    const height = state.map.length;
    const width = state.map[0]!.length;
    expect(width).toBeGreaterThanOrEqual(18);
    // Sea-heavy map — at least half the tiles are sea.
    const seaTiles = countTerrain(state, 'sea');
    expect(seaTiles).toBeGreaterThanOrEqual((width * height) / 2);

    // For each owner, locate factories and check at least one is coastal and
    // at least one is inland.
    const isSea = (x: number, y: number): boolean => {
      const row = state.map[y];
      if (!row) return false;
      const t = row[x];
      return t !== undefined && t.terrain === 'sea';
    };
    for (const owner of [0, 1] as const) {
      let coastal = 0;
      let inland = 0;
      let factories = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const t = state.map[y]![x]!;
          if (t.terrain !== 'factory' || t.owner !== owner) continue;
          factories += 1;
          const seaAdj =
            isSea(x - 1, y) || isSea(x + 1, y) || isSea(x, y - 1) || isSea(x, y + 1);
          if (seaAdj) coastal += 1;
          else inland += 1;
        }
      }
      expect(factories).toBeGreaterThanOrEqual(2);
      expect(coastal).toBeGreaterThanOrEqual(1);
      expect(inland).toBeGreaterThanOrEqual(1);
    }

    // Naval starting roster per player: transport, cruiser, battleship, submarine, infantry.
    const countByOwnerType = new Map<string, number>();
    for (const u of Object.values(state.units)) {
      const k = `${u.owner}:${u.type}`;
      countByOwnerType.set(k, (countByOwnerType.get(k) ?? 0) + 1);
    }
    for (const owner of [0, 1] as const) {
      for (const type of [
        'infantry',
        'transport',
        'cruiser',
        'battleship',
        'submarine',
      ] as UnitType[]) {
        expect(countByOwnerType.get(`${owner}:${type}`)).toBe(1);
      }
    }

    // Central island with neutral cities reachable only by sea drop or copter.
    expect(state.map[6]![9]!.terrain).toBe('city');
    expect(state.map[6]![10]!.terrain).toBe('city');
    expect(state.map[6]![9]!.owner).toBeNull();
    expect(state.map[6]![10]!.owner).toBeNull();
  });
});
