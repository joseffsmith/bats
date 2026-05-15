// Phase 7 roster expansion: six new unit types — fighter / bomber /
// battleship / cruiser / aatank / lander — driven entirely by data + sprite
// definitions. The engine itself gained no new mechanics; these tests pin
// the contract that:
//   - every new unit has a complete damage row + column,
//   - the new rock-paper-scissors couplings work (fighter > copter, etc.),
//   - the battleship inherits the existing indirect-attack rules,
//   - the lander reuses the transport cargo/LOAD/UNLOAD machinery,
//   - the build-menu filter for sea-class units extends to all four ships.

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';
import { computeDamage } from '../src/engine/systems/combat';
import { DAMAGE, UNITS } from '../src/engine/data';
import { buildMenuEntries } from '../src/renderer/hud';
import type { UnitType } from '../src/engine/core/types';

const NEW_TYPES: UnitType[] = [
  'fighter',
  'bomber',
  'battleship',
  'cruiser',
  'aatank',
  'lander',
];

const ALL_TYPES: UnitType[] = [
  'infantry',
  'recon',
  'tank',
  'artillery',
  'copter',
  'transport',
  ...NEW_TYPES,
];

describe('expanded roster: data integrity', () => {
  it('every new unit type appears in UNITS with positive cost and move', () => {
    for (const t of NEW_TYPES) {
      expect(UNITS[t]).toBeDefined();
      expect(UNITS[t].cost).toBeGreaterThan(0);
      expect(UNITS[t].move).toBeGreaterThan(0);
    }
  });

  it('damage matrix has a complete row + column for every new unit (incl. against itself)', () => {
    for (const a of NEW_TYPES) {
      expect(DAMAGE[a]).toBeDefined();
      for (const d of ALL_TYPES) {
        expect(typeof DAMAGE[a][d]).toBe('number');
      }
    }
    // Symmetric: every existing attacker has a cell for every new defender.
    for (const a of ALL_TYPES) {
      for (const d of NEW_TYPES) {
        expect(typeof DAMAGE[a][d]).toBe('number');
      }
    }
  });
});

// ─────────────────────────── Combat couplings ────────────────────────────────

/**
 * Helper: place attacker at (0,0) and defender at (gap,0) on road (0 stars),
 * both at full HP. Returns the (state, attacker, defender) triple.
 */
function pair(attackerType: UnitType, defenderType: UnitType, gap = 1) {
  const width = Math.max(3, gap + 2);
  const s = makeState({
    width,
    height: 2,
    defaultTerrain: 'road',
    hqs: [
      { owner: 0, pos: { x: 0, y: 1 } },
      { owner: 1, pos: { x: width - 1, y: 1 } },
    ],
    units: [
      { type: attackerType, owner: 0, pos: { x: 0, y: 0 } },
      { type: defenderType, owner: 1, pos: { x: gap, y: 0 } },
    ],
  });
  const a = Object.values(s.units).find((u) => u.owner === 0)!;
  const d = Object.values(s.units).find((u) => u.owner === 1)!;
  return { s, a, d };
}

describe('expanded roster: combat couplings', () => {
  it('fighter deals heavy damage to copter and almost nothing to tank', () => {
    {
      const { s, a, d } = pair('fighter', 'copter');
      expect(computeDamage(s, a, d)).toBeGreaterThanOrEqual(80);
    }
    {
      const { s, a, d } = pair('fighter', 'tank');
      expect(computeDamage(s, a, d)).toBeLessThanOrEqual(5);
    }
  });

  it('bomber wipes out tanks and is useless against fighters', () => {
    {
      const { s, a, d } = pair('bomber', 'tank');
      expect(computeDamage(s, a, d)).toBeGreaterThanOrEqual(80);
    }
    {
      const { s, a, d } = pair('bomber', 'fighter');
      expect(computeDamage(s, a, d)).toBeLessThanOrEqual(5);
    }
  });

  it('cruiser shreds fighters (anti-air specialist)', () => {
    const { s, a, d } = pair('cruiser', 'fighter');
    expect(computeDamage(s, a, d)).toBeGreaterThanOrEqual(80);
  });

  it('aatank wrecks bombers (anti-air specialist)', () => {
    const { s, a, d } = pair('aatank', 'bomber');
    expect(computeDamage(s, a, d)).toBeGreaterThanOrEqual(80);
  });

  it('lander deals zero damage to everything (non-combat transport)', () => {
    for (const t of ALL_TYPES) {
      const { s, a, d } = pair('lander', t);
      // Some pairings (e.g. lander vs lander) won't matter; just assert 0.
      expect(computeDamage(s, a, d)).toBe(0);
    }
  });
});

// ─────────────────────────── Battleship indirect ─────────────────────────────

describe('expanded roster: battleship indirect attack', () => {
  it('UNITS.battleship has min=2 max=6, indirect=true', () => {
    expect(UNITS.battleship.minRange).toBe(2);
    expect(UNITS.battleship.maxRange).toBe(6);
    expect(UNITS.battleship.indirect).toBe(true);
  });

  it('cannot attack a defender on an adjacent tile (range too short)', () => {
    const s = makeState({
      width: 8,
      height: 2,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 7, y: 1 } },
      ],
      tiles: [
        // Force HQs to be reachable (HQ terrain is defaulted to hq).
      ],
      units: [
        { type: 'battleship', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'cruiser', owner: 1, pos: { x: 1, y: 0 } },
      ],
    });
    const a = Object.values(s.units).find((u) => u.owner === 0)!;
    const t = Object.values(s.units).find((u) => u.owner === 1)!;
    const after = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: t.id });
    // Illegal -> NO-OP: same state.
    expect(after).toBe(s);
  });

  it('attacks a defender 3 tiles away on plain (in range)', () => {
    const s = makeState({
      width: 8,
      height: 2,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 7, y: 1 } },
      ],
      tiles: [{ pos: { x: 3, y: 0 }, terrain: 'plain' }],
      units: [
        { type: 'battleship', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'tank', owner: 1, pos: { x: 3, y: 0 } },
      ],
    });
    const a = Object.values(s.units).find((u) => u.owner === 0)!;
    const t = Object.values(s.units).find((u) => u.owner === 1)!;
    const after = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: t.id });
    expect(after).not.toBe(s);
    // Defender either took damage or was destroyed.
    const tAfter = after.units[t.id];
    if (tAfter) {
      expect(tAfter.hp).toBeLessThan(100);
    }
  });

  it('battleship damage drops on high-defence terrain (mountain)', () => {
    // Tank on plain vs tank on mountain — battleship damage must be lower
    // against the mountain target because of the defence-stars term in the
    // combat formula.
    function dmgAgainst(terrain: 'plain' | 'mountain'): number {
      const s = makeState({
        width: 8,
        height: 2,
        defaultTerrain: 'sea',
        hqs: [
          { owner: 0, pos: { x: 0, y: 1 } },
          { owner: 1, pos: { x: 7, y: 1 } },
        ],
        tiles: [{ pos: { x: 3, y: 0 }, terrain }],
        units: [
          { type: 'battleship', owner: 0, pos: { x: 0, y: 0 } },
          { type: 'tank', owner: 1, pos: { x: 3, y: 0 } },
        ],
      });
      const a = Object.values(s.units).find((u) => u.owner === 0)!;
      const t = Object.values(s.units).find((u) => u.owner === 1)!;
      return computeDamage(s, a, t);
    }
    const plain = dmgAgainst('plain');
    const mountain = dmgAgainst('mountain');
    expect(mountain).toBeLessThan(plain);
  });
});

// ─────────────────────────── Lander LOAD / UNLOAD ────────────────────────────

describe('expanded roster: lander cargo model', () => {
  it('UNITS.lander accepts foot/wheel/tread cargo, capacity 1', () => {
    expect(UNITS.lander.cargoCapacity).toBe(1);
    expect(UNITS.lander.cargoMovementClasses).toEqual(['foot', 'wheel', 'tread']);
  });

  it('LOAD a tank onto a lander parked on sea', () => {
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
        { type: 'lander', owner: 0, pos: { x: 2, y: 0 } },
      ],
    });
    const [tankId, landerId] = Object.keys(s.units);
    const st = reduce(s, {
      type: 'LOAD',
      cargoId: tankId!,
      transportId: landerId!,
      path: [{ x: 2, y: 0 }],
    });
    expect(st).not.toBe(s);
    expect(st.units[tankId!]!.loadedIn).toBe(landerId);
    expect(st.units[landerId!]!.cargo).toEqual([tankId]);
  });

  it('rejects loading a second unit (capacity=1)', () => {
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
        { type: 'lander', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'tank', owner: 0, pos: { x: 2, y: 0 } },
      ],
    });
    const [infId, landerId, tankId] = Object.keys(s.units);
    const st1 = reduce(s, {
      type: 'LOAD',
      cargoId: infId!,
      transportId: landerId!,
      path: [{ x: 1, y: 0 }],
    });
    expect(st1.units[landerId!]!.cargo).toEqual([infId]);
    // Second LOAD must be rejected.
    const st2 = reduce(st1, {
      type: 'LOAD',
      cargoId: tankId!,
      transportId: landerId!,
      path: [{ x: 1, y: 0 }],
    });
    expect(st2).toBe(st1);
  });

  it('UNLOAD a tank onto an adjacent land tile after one round trip', () => {
    const s = makeState({
      width: 4,
      height: 3,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 2 } },
      ],
      tiles: [{ pos: { x: 1, y: 1 }, terrain: 'sea' }],
      units: [
        { type: 'tank', owner: 0, pos: { x: 0, y: 1 } },
        { type: 'lander', owner: 0, pos: { x: 1, y: 1 } },
        // Dummy enemy so the rout check doesn't end the game on END_TURN.
        { type: 'infantry', owner: 1, pos: { x: 3, y: 2 } },
      ],
    });
    const [tankId, landerId] = Object.keys(s.units);
    let st = reduce(s, {
      type: 'LOAD',
      cargoId: tankId!,
      transportId: landerId!,
      path: [{ x: 1, y: 1 }],
    });
    // Two END_TURNs to return to player 0 with reset flags.
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    const after = reduce(st, {
      type: 'UNLOAD',
      transportId: landerId!,
      cargoId: tankId!,
      destination: { x: 1, y: 0 },
    });
    expect(after).not.toBe(st);
    const tank = after.units[tankId!]!;
    expect(tank.loadedIn).toBeUndefined();
    expect(tank.pos).toEqual({ x: 1, y: 0 });
    expect(tank.hasMoved).toBe(true);
    expect(tank.hasActed).toBe(true);
    expect(after.units[landerId!]!.cargo).toEqual([]);
  });
});

// ─────────────────────────── BUILD legality / build menu ─────────────────────

function makeFactoryState(opts: { coastal: boolean; funds: number }) {
  // 3x3 map: factory at (1,1), HQs at corners, optional sea tile adjacent.
  // Without the sea tile the factory is landlocked → sea-class builds illegal.
  return makeState({
    width: 3,
    height: 3,
    hqs: [
      { owner: 0, pos: { x: 0, y: 0 } },
      { owner: 1, pos: { x: 2, y: 2 } },
    ],
    tiles: [
      { pos: { x: 1, y: 1 }, terrain: 'factory', owner: 0 },
      ...(opts.coastal ? [{ pos: { x: 1, y: 2 }, terrain: 'sea' as const }] : []),
    ],
    funds: { 0: opts.funds },
  });
}

describe('expanded roster: BUILD legality', () => {
  it('fighter and bomber build on any factory (air-class)', () => {
    const s = makeFactoryState({ coastal: false, funds: 30000 });
    for (const type of ['fighter', 'bomber'] as UnitType[]) {
      const after = reduce(s, {
        type: 'BUILD',
        at: { x: 1, y: 1 },
        unitType: type,
        owner: 0,
      });
      expect(after).not.toBe(s);
      const built = Object.values(after.units).find(
        (u) => u.owner === 0 && u.type === type,
      );
      expect(built).toBeDefined();
    }
  });

  it('aatank builds on any factory (tread-class)', () => {
    const s = makeFactoryState({ coastal: false, funds: 10000 });
    const after = reduce(s, {
      type: 'BUILD',
      at: { x: 1, y: 1 },
      unitType: 'aatank',
      owner: 0,
    });
    expect(after).not.toBe(s);
    const built = Object.values(after.units).find(
      (u) => u.owner === 0 && u.type === 'aatank',
    );
    expect(built).toBeDefined();
  });

  it('battleship / cruiser / lander require a coastal factory', () => {
    const landlocked = makeFactoryState({ coastal: false, funds: 30000 });
    for (const type of ['battleship', 'cruiser', 'lander'] as UnitType[]) {
      const after = reduce(landlocked, {
        type: 'BUILD',
        at: { x: 1, y: 1 },
        unitType: type,
        owner: 0,
      });
      // Illegal -> NO-OP.
      expect(after).toBe(landlocked);
    }
    const coastal = makeFactoryState({ coastal: true, funds: 30000 });
    for (const type of ['battleship', 'cruiser', 'lander'] as UnitType[]) {
      const after = reduce(coastal, {
        type: 'BUILD',
        at: { x: 1, y: 1 },
        unitType: type,
        owner: 0,
      });
      expect(after).not.toBe(coastal);
      const built = Object.values(after.units).find(
        (u) => u.owner === 0 && u.type === type,
      );
      expect(built).toBeDefined();
    }
  });

  it('build menu lists sea-class units only on coastal factories', () => {
    const landlocked = makeFactoryState({ coastal: false, funds: 100000 });
    const landTypes = buildMenuEntries(landlocked, 0, { x: 1, y: 1 }).map(
      (e) => e.unitType,
    );
    for (const t of ['transport', 'lander', 'cruiser', 'battleship']) {
      expect(landTypes).not.toContain(t);
    }
    // Air + land units are still offered.
    expect(landTypes).toContain('fighter');
    expect(landTypes).toContain('bomber');
    expect(landTypes).toContain('aatank');

    const coastal = makeFactoryState({ coastal: true, funds: 100000 });
    const coastTypes = buildMenuEntries(coastal, 0, { x: 1, y: 1 }).map(
      (e) => e.unitType,
    );
    for (const t of ['transport', 'lander', 'cruiser', 'battleship']) {
      expect(coastTypes).toContain(t);
    }
  });
});
