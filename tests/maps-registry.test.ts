// Sanity tests for the renderer's map registry. Verifies:
//   - every known map name resolves to a JSON object that the engine loader
//     accepts;
//   - resolveMapName falls back to DEFAULT_MAP on garbage input;
//   - mapLabel produces a stable display string.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAP,
  MAP_NAMES,
  MAPS,
  mapLabel,
  resolveMapName,
} from '../src/renderer/maps';
import { loadMap } from '../src/engine/data/loader';

describe('maps registry', () => {
  it('every map name loads via the engine loader', () => {
    for (const name of MAP_NAMES) {
      const json = MAPS[name];
      expect(json).toBeTruthy();
      const state = loadMap(json);
      expect(state.map.length).toBeGreaterThan(0);
      expect(Object.keys(state.players)).toContain('0');
      expect(Object.keys(state.players)).toContain('1');
    }
  });

  it('resolveMapName accepts every known name', () => {
    for (const name of MAP_NAMES) {
      expect(resolveMapName(name)).toBe(name);
    }
  });

  it('resolveMapName falls back to default on garbage', () => {
    expect(resolveMapName(null)).toBe(DEFAULT_MAP);
    expect(resolveMapName(undefined)).toBe(DEFAULT_MAP);
    expect(resolveMapName('')).toBe(DEFAULT_MAP);
    expect(resolveMapName('atlantis')).toBe(DEFAULT_MAP);
    expect(resolveMapName('DUEL')).toBe(DEFAULT_MAP); // case-sensitive
  });

  it('mapLabel humanizes snake_case', () => {
    expect(mapLabel('duel')).toBe('Duel');
    expect(mapLabel('crossroads')).toBe('Crossroads');
    expect(mapLabel('island_hop')).toBe('Island Hop');
    expect(mapLabel('canyon')).toBe('Canyon');
  });
});
