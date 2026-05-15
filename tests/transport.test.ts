// Transport unit type: LOAD + UNLOAD action semantics, cargo model edge cases.
//
// The transport adds two genre-staple actions to the engine:
//   - LOAD: a cargo unit MOVEs onto an adjacent or path-reachable transport
//     tile and is loaded as cargo. Special-case pathfinding: stopping on a
//     friendly unit's tile is normally illegal, but LOAD's validator carves
//     out an exception for the named transport.
//   - UNLOAD: a transport (which hasn't acted this turn) drops a cargo unit
//     onto an adjacent passable, unoccupied tile. Per AW convention both
//     transport AND cargo are marked hasActed after UNLOAD.
//
// Cargo model: loaded units stay in `state.units` with `loadedIn` set; their
// pos tracks the carrier's pos but is irrelevant for combat/pathfinding (the
// engine's `unitAt` and `attackableTargets` skip them). When the carrier is
// destroyed, every cargo unit dies with it.

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';
import {
  attackableTargets,
  reachableTiles,
} from '../src/engine/queries/selectors';
import { unitAt } from '../src/engine/core/types';

describe('transport: LOAD', () => {
  it('infantry adjacent to friendly transport loads onto it in one action', () => {
    // Layout: infantry at (1,0), transport at (2,0) on sea. Infantry walks
    // east onto the transport tile via LOAD.
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      tiles: [{ pos: { x: 2, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'transport', owner: 0, pos: { x: 2, y: 0 } },
      ],
    });
    const [infId, transportId] = Object.keys(s.units);
    const st = reduce(s, {
      type: 'LOAD',
      cargoId: infId!,
      transportId: transportId!,
      path: [{ x: 2, y: 0 }],
    });
    // Should have applied: state must have changed.
    expect(st).not.toBe(s);
    const inf = st.units[infId!]!;
    const tr = st.units[transportId!]!;
    expect(inf.loadedIn).toBe(transportId);
    expect(inf.pos).toEqual({ x: 2, y: 0 });
    expect(inf.hasMoved).toBe(true);
    expect(inf.hasActed).toBe(true);
    expect(tr.cargo).toEqual([infId]);
  });

  it('LOAD across a multi-step path ending on the transport', () => {
    // Infantry at (0,0); empty plains across (0..2); transport at (3,0).
    const s = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      // Put the transport on a coast tile (sea) so its movement class is
      // legal there.
      tiles: [{ pos: { x: 3, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'transport', owner: 0, pos: { x: 3, y: 0 } },
      ],
    });
    const [infId, transportId] = Object.keys(s.units);
    // Infantry has move=3 on plain (cost 1 each), so 3 steps is exactly
    // budget-fitting: (1,0) → (2,0) → (3,0). HQ tile is at (0,0).
    const path = [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ];
    const st = reduce(s, {
      type: 'LOAD',
      cargoId: infId!,
      transportId: transportId!,
      path,
    });
    expect(st).not.toBe(s);
    expect(st.units[infId!]!.loadedIn).toBe(transportId);
    expect(st.units[transportId!]!.cargo).toEqual([infId]);
  });

  it('rejects LOAD when transport is at capacity', () => {
    // Two infantry + transport (capacity=1). First infantry loads cleanly,
    // second is rejected.
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'transport', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 0, pos: { x: 2, y: 0 } },
      ],
    });
    const [hqInfId, transportId, otherInfId] = Object.keys(s.units);
    // First infantry loads.
    const st1 = reduce(s, {
      type: 'LOAD',
      cargoId: hqInfId!,
      transportId: transportId!,
      path: [{ x: 1, y: 0 }],
    });
    expect(st1.units[transportId!]!.cargo).toEqual([hqInfId]);
    // Second infantry tries to load: rejected (capacity 1).
    const st2 = reduce(st1, {
      type: 'LOAD',
      cargoId: otherInfId!,
      transportId: transportId!,
      path: [{ x: 1, y: 0 }],
    });
    // Illegal -> NO-OP, returns same state.
    expect(st2).toBe(st1);
  });

  it("rejects LOAD when cargo's movement class isn't supported", () => {
    // Tank (movementClass=tread) cannot load into transport (accepts foot).
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      tiles: [{ pos: { x: 2, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'tank', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'transport', owner: 0, pos: { x: 2, y: 0 } },
      ],
    });
    const [tankId, transportId] = Object.keys(s.units);
    const st = reduce(s, {
      type: 'LOAD',
      cargoId: tankId!,
      transportId: transportId!,
      path: [{ x: 2, y: 0 }],
    });
    expect(st).toBe(s);
  });

  it('rejects LOAD path that crosses an enemy unit', () => {
    // Infantry at (0,0), enemy infantry blocking (1,0), transport at (2,0).
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      tiles: [{ pos: { x: 2, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 1, y: 0 } },
        { type: 'transport', owner: 0, pos: { x: 2, y: 0 } },
      ],
    });
    const [meId, , transportId] = Object.keys(s.units);
    const st = reduce(s, {
      type: 'LOAD',
      cargoId: meId!,
      transportId: transportId!,
      path: [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
    });
    expect(st).toBe(s);
  });
});

describe('transport: UNLOAD', () => {
  function loadedSetup() {
    // Infantry already loaded in transport at (1,1). Transport on sea;
    // adjacent plain tiles available for disembarking. Dummy enemy keeps
    // the rout win condition from firing across END_TURNs.
    const s = makeState({
      width: 4,
      height: 3,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 2 } },
      ],
      tiles: [
        { pos: { x: 1, y: 1 }, terrain: 'sea' },
        // Make (2,1) impassable for foot to test that case below.
        { pos: { x: 2, y: 1 }, terrain: 'sea' },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 1 } },
        { type: 'transport', owner: 0, pos: { x: 1, y: 1 } },
        // Dummy enemy on its HQ — far away so it doesn't interact.
        { type: 'infantry', owner: 1, pos: { x: 3, y: 2 } },
      ],
    });
    const [infId, transportId] = Object.keys(s.units);
    const loaded = reduce(s, {
      type: 'LOAD',
      cargoId: infId!,
      transportId: transportId!,
      path: [{ x: 1, y: 1 }],
    });
    // End turn (player 0 → 1 → 0) to reset hasActed on transport+cargo so
    // we can UNLOAD on a fresh turn.
    let st = reduce(loaded, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    return { st, infId: infId!, transportId: transportId! };
  }

  it('UNLOAD onto an adjacent passable tile succeeds; both flags acted', () => {
    const { st, infId, transportId } = loadedSetup();
    // (1,0) is plain — passable for foot.
    const after = reduce(st, {
      type: 'UNLOAD',
      transportId,
      cargoId: infId,
      destination: { x: 1, y: 0 },
    });
    expect(after).not.toBe(st);
    const inf = after.units[infId]!;
    const tr = after.units[transportId]!;
    expect(inf.loadedIn).toBeUndefined();
    expect(inf.pos).toEqual({ x: 1, y: 0 });
    expect(inf.hasMoved).toBe(true);
    expect(inf.hasActed).toBe(true);
    expect(tr.hasActed).toBe(true);
    expect(tr.cargo).toEqual([]);
  });

  it('rejects UNLOAD onto impassable terrain', () => {
    const { st, infId, transportId } = loadedSetup();
    // (2,1) is sea — impassable for foot.
    const after = reduce(st, {
      type: 'UNLOAD',
      transportId,
      cargoId: infId,
      destination: { x: 2, y: 1 },
    });
    expect(after).toBe(st);
  });

  it('rejects UNLOAD when cargo is not loaded in this transport', () => {
    const { st, transportId } = loadedSetup();
    // Try unloading a non-existent cargo id.
    const after = reduce(st, {
      type: 'UNLOAD',
      transportId,
      cargoId: 'u-not-real',
      destination: { x: 1, y: 0 },
    });
    expect(after).toBe(st);
  });

  it('rejects UNLOAD when destination is occupied', () => {
    const { st, infId, transportId } = loadedSetup();
    // Place a friendly unit at (1,0) so UNLOAD destination is occupied.
    const blocked = {
      ...st,
      units: {
        ...st.units,
        'extra-blocker': {
          id: 'extra-blocker',
          type: 'infantry' as const,
          owner: 0 as const,
          pos: { x: 1, y: 0 },
          hp: 100,
          hasMoved: false,
          hasActed: false,
          captureProgress: 0,
        },
      },
    };
    const after = reduce(blocked, {
      type: 'UNLOAD',
      transportId,
      cargoId: infId,
      destination: { x: 1, y: 0 },
    });
    expect(after).toBe(blocked);
  });
});

describe('transport: cargo opacity', () => {
  it('unitAt returns the transport (not the loaded unit) at the transport tile', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'transport', owner: 0, pos: { x: 1, y: 0 } },
      ],
    });
    const [infId, transportId] = Object.keys(s.units);
    const st = reduce(s, {
      type: 'LOAD',
      cargoId: infId!,
      transportId: transportId!,
      path: [{ x: 1, y: 0 }],
    });
    const occ = unitAt(st, { x: 1, y: 0 });
    expect(occ?.id).toBe(transportId);
  });

  it('loaded units are skipped by attackableTargets (enemy cannot shoot cargo directly)', () => {
    // Setup: enemy infantry adjacent to a player-0 transport carrying a
    // player-0 infantry. The enemy's attackableTargets should list the
    // transport but NOT the loaded infantry.
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'transport', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const [infId, transportId, enemyId] = Object.keys(s.units);
    const st = reduce(s, {
      type: 'LOAD',
      cargoId: infId!,
      transportId: transportId!,
      path: [{ x: 1, y: 0 }],
    });
    const enemy = st.units[enemyId!]!;
    const targets = attackableTargets(st, enemy);
    const targetIds = targets.map((t) => t.id);
    expect(targetIds).toContain(transportId);
    expect(targetIds).not.toContain(infId);
  });

  it('cargo dies when transport is destroyed in combat', () => {
    // Setup: player-0 transport at low HP carrying an infantry; enemy tank
    // adjacent. Tank ATTACK destroys the transport, and the cargo unit must
    // be removed from state.units.
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        // Low-HP transport so a single tank shot kills it.
        { type: 'transport', owner: 0, pos: { x: 1, y: 0 }, hp: 10 },
        { type: 'tank', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const [infId, transportId, tankId] = Object.keys(s.units);
    // Load the infantry into the transport.
    const loaded = reduce(s, {
      type: 'LOAD',
      cargoId: infId!,
      transportId: transportId!,
      path: [{ x: 1, y: 0 }],
    });
    expect(loaded.units[transportId!]!.cargo).toEqual([infId]);
    // End turn so it's player 1's turn (and the tank can act).
    const p1Turn = reduce(loaded, { type: 'END_TURN' });
    const after = reduce(p1Turn, {
      type: 'ATTACK',
      attackerId: tankId!,
      targetId: transportId!,
    });
    expect(after.units[transportId!]).toBeUndefined();
    expect(after.units[infId!]).toBeUndefined();
  });

  it("loaded unit's flags reset on owner's next END_TURN", () => {
    // After LOAD on turn 1, infantry has hasActed=true. After two END_TURNs
    // (returning to player 0), the infantry should have hasMoved=hasActed=false
    // so it's eligible to be unloaded into action.
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'transport', owner: 0, pos: { x: 1, y: 0 } },
        // Dummy enemy so rout doesn't end the game on END_TURN.
        { type: 'infantry', owner: 1, pos: { x: 3, y: 0 } },
      ],
    });
    const [infId, transportId] = Object.keys(s.units);
    let st = reduce(s, {
      type: 'LOAD',
      cargoId: infId!,
      transportId: transportId!,
      path: [{ x: 1, y: 0 }],
    });
    expect(st.units[infId!]!.hasActed).toBe(true);
    st = reduce(st, { type: 'END_TURN' }); // → player 1
    st = reduce(st, { type: 'END_TURN' }); // → player 0
    expect(st.units[infId!]!.hasMoved).toBe(false);
    expect(st.units[infId!]!.hasActed).toBe(false);
    // Still loaded.
    expect(st.units[infId!]!.loadedIn).toBe(transportId);
  });
});

describe('transport: pathfinding integration', () => {
  it("foot unit's reachableTiles includes a friendly transport-with-capacity tile", () => {
    // Infantry at (0,0); transport at (1,0) on sea (adjacent, in reach).
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'transport', owner: 0, pos: { x: 1, y: 0 } },
      ],
    });
    const inf = Object.values(s.units).find((u) => u.type === 'infantry')!;
    const reach = reachableTiles(s, inf);
    const dests = reach.map((r) => `${r.coord.x},${r.coord.y}`);
    expect(dests).toContain('1,0');
  });

  it('reachableTiles excludes a friendly transport that is at capacity', () => {
    // Same as above but the transport already carries one cargo (so capacity
    // is full). It should be excluded from reachableTiles for a third unit.
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'transport', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 0, pos: { x: 2, y: 0 } },
      ],
    });
    const [aId, transportId, bId] = Object.keys(s.units);
    const loaded = reduce(s, {
      type: 'LOAD',
      cargoId: aId!,
      transportId: transportId!,
      path: [{ x: 1, y: 0 }],
    });
    const other = loaded.units[bId!]!;
    const reach = reachableTiles(loaded, other);
    const dests = reach.map((r) => `${r.coord.x},${r.coord.y}`);
    expect(dests).not.toContain('1,0');
  });
});
