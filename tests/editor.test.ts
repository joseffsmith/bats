// Phase 6 map editor integration test.
//
// Drives the headless `createEditor()` API: paint a small map (HQs, factories,
// a few cities), serialise to JSON, round-trip through the engine loader, and
// confirm the resulting GameState has the painted properties.
//
// No DOM is required for this test — the editor's core is pure data.

import { describe, expect, it } from 'vitest';
import { createEditor } from '../src/renderer/editor';
import { loadMap } from '../src/engine/data/loader';

describe('map editor', () => {
  it('paints, serialises, and round-trips through the loader', () => {
    const ed = createEditor();
    ed.setSize(6, 5);
    ed.setName('test_arena');
    // Both HQs.
    ed.paint(0, 2, { kind: 'owned', terrain: 'hq', owner: 0 });
    ed.paint(5, 2, { kind: 'owned', terrain: 'hq', owner: 1 });
    // Factories adjacent to each HQ.
    ed.paint(1, 2, { kind: 'owned', terrain: 'factory', owner: 0 });
    ed.paint(4, 2, { kind: 'owned', terrain: 'factory', owner: 1 });
    // A neutral city in the middle.
    ed.paint(3, 0, { kind: 'terrain', terrain: 'city' });
    // A forest patch.
    ed.paint(3, 3, { kind: 'terrain', terrain: 'forest' });

    expect(ed.validate()).toBeNull();
    const json = ed.toJson();
    const state = loadMap(json);
    expect(state.players[0].hq).toEqual({ x: 0, y: 2 });
    expect(state.players[1].hq).toEqual({ x: 5, y: 2 });
    expect(state.map[2]![1]!.terrain).toBe('factory');
    expect(state.map[2]![1]!.owner).toBe(0);
    expect(state.map[2]![4]!.terrain).toBe('factory');
    expect(state.map[0]![3]!.terrain).toBe('city');
    expect(state.map[3]![3]!.terrain).toBe('forest');
  });

  it('clear() resets a tile back to plain', () => {
    const ed = createEditor();
    ed.setSize(3, 3);
    ed.paint(1, 1, { kind: 'terrain', terrain: 'forest' });
    expect(ed.state().tiles[1]![1]!.terrain).toBe('forest');
    ed.clear(1, 1);
    expect(ed.state().tiles[1]![1]!.terrain).toBe('plain');
    expect(ed.state().tiles[1]![1]!.owner).toBe(null);
  });

  it('placing a second HQ for the same owner removes the first', () => {
    const ed = createEditor();
    ed.setSize(4, 4);
    ed.paint(0, 0, { kind: 'owned', terrain: 'hq', owner: 0 });
    ed.paint(3, 3, { kind: 'owned', terrain: 'hq', owner: 0 });
    expect(ed.state().tiles[0]![0]!.terrain).toBe('plain');
    expect(ed.state().tiles[3]![3]!.terrain).toBe('hq');
  });

  it('validate() reports a clear error for a missing HQ', () => {
    const ed = createEditor();
    ed.setSize(4, 4);
    // Only one HQ placed.
    ed.paint(0, 0, { kind: 'owned', terrain: 'hq', owner: 0 });
    const err = ed.validate();
    expect(err).toBeTruthy();
    expect(err).toMatch(/hq/i);
  });

  it('importJson loads an existing map back into the editor', () => {
    const ed = createEditor();
    const initialSize = ed.state();
    expect(initialSize.width).toBeGreaterThan(0);
    // First, build a small valid map manually.
    ed.setSize(5, 5);
    ed.paint(0, 2, { kind: 'owned', terrain: 'hq', owner: 0 });
    ed.paint(4, 2, { kind: 'owned', terrain: 'hq', owner: 1 });
    const json = ed.toJson();
    // Then import it into a fresh editor.
    const ed2 = createEditor();
    ed2.importJson(json);
    expect(ed2.state().width).toBe(5);
    expect(ed2.state().height).toBe(5);
    expect(ed2.state().tiles[2]![0]!.terrain).toBe('hq');
    expect(ed2.state().tiles[2]![0]!.owner).toBe(0);
  });
});
