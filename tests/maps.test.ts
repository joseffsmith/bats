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
import type { GameState, TerrainType } from '../src/engine/core/types';

const ALL_MAPS = [
  { name: 'duel', json: duelMap as unknown },
  { name: 'crossroads', json: crossroadsMap as unknown },
  { name: 'island_hop', json: islandHopMap as unknown },
  { name: 'canyon', json: canyonMap as unknown },
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

  it('canyon has the mountain spine and roads along the edges', () => {
    const state = loadMap(canyonMap as unknown);
    expect(state.map[0]!.every((t) => t.terrain === 'road')).toBe(true);
    expect(state.map[9]!.every((t) => t.terrain === 'road')).toBe(true);
    // Mountain row in the middle.
    expect(countTerrain(state, 'mountain')).toBeGreaterThanOrEqual(20);
    // Central chokepoint city at (7,5).
    expect(state.map[5]![7]!.terrain).toBe('city');
  });
});
