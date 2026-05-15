// Carrier: air-cargo variant of the transport. Reuses the existing
// LOAD/UNLOAD machinery with `cargoMovementClasses = ['air']` and
// `cargoCapacity = 2`. The engine gained nothing new — these tests pin the
// contract that:
//   - air-class units (fighter, bomber, copter) LOAD onto a carrier,
//   - ground / sea units are rejected (movement class not accepted),
//   - capacity caps at 2,
//   - UNLOAD onto any adjacent passable tile works (air ignores terrain),
//     while an enemy-occupied tile is rejected,
//   - the cargo-cascade-on-death rule from the transport applies (cargo
//     dies when the carrier sinks).

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';
import { UNITS } from '../src/engine/data';

describe('carrier: data integrity', () => {
  it('carrier is a sea-class transport accepting air cargo, capacity 2', () => {
    expect(UNITS.carrier).toBeDefined();
    expect(UNITS.carrier.cost).toBe(22000);
    expect(UNITS.carrier.move).toBe(5);
    expect(UNITS.carrier.movementClass).toBe('sea');
    expect(UNITS.carrier.cargoCapacity).toBe(2);
    expect(UNITS.carrier.cargoMovementClasses).toContain('air');
    expect(UNITS.carrier.minRange).toBe(0);
    expect(UNITS.carrier.maxRange).toBe(0);
  });
});

describe('carrier: LOAD', () => {
  it('LOAD accepts a fighter (air movement class)', () => {
    // Fighter adjacent to a carrier on sea. Fighter walks onto the carrier
    // tile via LOAD.
    const s = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 2, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'fighter', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'carrier', owner: 0, pos: { x: 2, y: 0 } },
      ],
    });
    const [fighterId, carrierId] = Object.keys(s.units);
    const st = reduce(s, {
      type: 'LOAD',
      cargoId: fighterId!,
      transportId: carrierId!,
      path: [{ x: 2, y: 0 }],
    });
    expect(st).not.toBe(s);
    expect(st.units[fighterId!]!.loadedIn).toBe(carrierId);
    expect(st.units[carrierId!]!.cargo).toEqual([fighterId]);
  });

  it('LOAD accepts a copter (also air class)', () => {
    const s = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 2, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'copter', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'carrier', owner: 0, pos: { x: 2, y: 0 } },
      ],
    });
    const [copterId, carrierId] = Object.keys(s.units);
    const st = reduce(s, {
      type: 'LOAD',
      cargoId: copterId!,
      transportId: carrierId!,
      path: [{ x: 2, y: 0 }],
    });
    expect(st).not.toBe(s);
    expect(st.units[copterId!]!.loadedIn).toBe(carrierId);
  });

  it('LOAD rejects a tank (movement class not accepted)', () => {
    // The tank is placed adjacent to the carrier on a plain tile so its
    // reachable set includes the carrier — the rejection has to come from
    // the cargoMovementClasses check, not from a movement-class-on-sea
    // issue.
    const s = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 2, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'tank', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'carrier', owner: 0, pos: { x: 2, y: 0 } },
      ],
    });
    const [tankId, carrierId] = Object.keys(s.units);
    const st = reduce(s, {
      type: 'LOAD',
      cargoId: tankId!,
      transportId: carrierId!,
      path: [{ x: 2, y: 0 }],
    });
    expect(st).toBe(s); // NO-OP
  });

  it('LOAD rejects beyond capacity (carrier capacity = 2)', () => {
    const s = makeState({
      width: 5,
      height: 3,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 2 } },
      ],
      tiles: [{ pos: { x: 2, y: 1 }, terrain: 'sea' }],
      units: [
        { type: 'fighter', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'carrier', owner: 0, pos: { x: 2, y: 1 } },
        { type: 'bomber', owner: 0, pos: { x: 1, y: 1 } },
        // Third air unit far enough to load if there were capacity left.
        { type: 'copter', owner: 0, pos: { x: 3, y: 1 } },
        // Dummy enemy so a rout doesn't end the game after the first LOAD.
        { type: 'infantry', owner: 1, pos: { x: 4, y: 2 } },
      ],
    });
    const [fId, cId, bId, hId] = Object.keys(s.units);
    let st = reduce(s, {
      type: 'LOAD',
      cargoId: fId!,
      transportId: cId!,
      path: [{ x: 2, y: 1 }],
    });
    expect(st.units[cId!]!.cargo).toEqual([fId]);
    st = reduce(st, {
      type: 'LOAD',
      cargoId: bId!,
      transportId: cId!,
      path: [{ x: 2, y: 1 }],
    });
    expect(st.units[cId!]!.cargo).toEqual([fId, bId]);
    // Third LOAD must fail.
    const blocked = reduce(st, {
      type: 'LOAD',
      cargoId: hId!,
      transportId: cId!,
      path: [{ x: 2, y: 1 }],
    });
    expect(blocked).toBe(st);
  });
});

describe('carrier: UNLOAD', () => {
  function loadedSetup() {
    // Fighter loaded on a carrier at (2,1). Adjacent plain tiles for the
    // unload destination. Dummy enemy to prevent rout on END_TURN.
    const s = makeState({
      width: 5,
      height: 3,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 2 } },
      ],
      tiles: [{ pos: { x: 2, y: 1 }, terrain: 'sea' }],
      units: [
        { type: 'fighter', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'carrier', owner: 0, pos: { x: 2, y: 1 } },
        // Dummy enemy.
        { type: 'infantry', owner: 1, pos: { x: 4, y: 2 } },
      ],
    });
    const [fighterId, carrierId] = Object.keys(s.units);
    let st = reduce(s, {
      type: 'LOAD',
      cargoId: fighterId!,
      transportId: carrierId!,
      path: [{ x: 2, y: 1 }],
    });
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    return { st, fighterId: fighterId!, carrierId: carrierId! };
  }

  it('UNLOAD onto an adjacent plain tile succeeds', () => {
    const { st, fighterId, carrierId } = loadedSetup();
    const after = reduce(st, {
      type: 'UNLOAD',
      transportId: carrierId,
      cargoId: fighterId,
      destination: { x: 2, y: 0 },
    });
    expect(after).not.toBe(st);
    const f = after.units[fighterId]!;
    const c = after.units[carrierId]!;
    expect(f.loadedIn).toBeUndefined();
    expect(f.pos).toEqual({ x: 2, y: 0 });
    expect(f.hasMoved).toBe(true);
    expect(f.hasActed).toBe(true);
    expect(c.hasActed).toBe(true);
    expect(c.cargo).toEqual([]);
  });

  it('UNLOAD onto an enemy-occupied tile is rejected', () => {
    const { st, fighterId, carrierId } = loadedSetup();
    // Drop an enemy unit on the intended destination.
    const blocked = {
      ...st,
      units: {
        ...st.units,
        'extra-enemy': {
          id: 'extra-enemy',
          type: 'infantry' as const,
          owner: 1 as const,
          pos: { x: 2, y: 0 },
          hp: 100,
          hasMoved: false,
          hasActed: false,
          captureProgress: 0,
        },
      },
    };
    const after = reduce(blocked, {
      type: 'UNLOAD',
      transportId: carrierId,
      cargoId: fighterId,
      destination: { x: 2, y: 0 },
    });
    expect(after).toBe(blocked);
  });
});

describe('carrier: cargo cascade on death', () => {
  it('when the carrier is destroyed, its cargo dies too', () => {
    // Low-HP carrier carrying a fighter; an enemy battleship in range one-shots it.
    const s = makeState({
      width: 6,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 0 } },
      ],
      tiles: [
        { pos: { x: 2, y: 0 }, terrain: 'sea' },
        { pos: { x: 3, y: 0 }, terrain: 'sea' },
        { pos: { x: 4, y: 0 }, terrain: 'sea' },
      ],
      units: [
        { type: 'fighter', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'carrier', owner: 0, pos: { x: 2, y: 0 }, hp: 8 },
        { type: 'battleship', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const [fighterId, carrierId, bsId] = Object.keys(s.units);
    // LOAD the fighter onto the carrier.
    const loaded = reduce(s, {
      type: 'LOAD',
      cargoId: fighterId!,
      transportId: carrierId!,
      path: [{ x: 2, y: 0 }],
    });
    expect(loaded.units[carrierId!]!.cargo).toEqual([fighterId]);
    // Player 1's turn; battleship attacks the (low-HP) carrier.
    const p1Turn = reduce(loaded, { type: 'END_TURN' });
    const after = reduce(p1Turn, {
      type: 'ATTACK',
      attackerId: bsId!,
      targetId: carrierId!,
    });
    expect(after.units[carrierId!]).toBeUndefined();
    expect(after.units[fighterId!]).toBeUndefined();
  });
});
