// Submarine: the headline Tier-3 stealth mechanic. Adds a persistent
// `submerged` flag to Unit plus two new actions (DIVE / SURFACE) and a new
// viewer-aware visibility predicate (`visibleUnitAt`, `isVisibleTo`).
//
// Engine contract:
//   - DIVE / SURFACE: legal only for submarines that haven't acted; toggles
//     `submerged` and marks hasMoved = hasActed = true. Illegal-when-not-sub
//     returns the original state (NO-OP).
//   - `attackableTargets` filters submerged enemy subs for non-cruiser /
//     non-sub attackers regardless of range. Cruiser and submarine
//     attackers can still target a submerged sub.
//   - `visibleUnitAt(state, c, viewer)` masks an enemy submerged sub unless
//     the viewer has a cruiser or submarine within Manhattan distance 1.
//     Own units (including own submerged subs) are always visible to their
//     owner.
//
// Combat shape:
//   - submarine.maxRange = 1 (direct fire); damage row covers surface-sea
//     units heavily (battleship 95, cruiser 80, lander/transport 90,
//     submarine 80, carrier 95) and is 0 against air/ground.
//   - cruiser-vs-submarine = 105 (one-shot at full HP, mirroring the
//     existing cruiser-vs-air balance).
//   - battleship-vs-submarine = 75 (large surface gun reaches a surfaced
//     sub for >= 75 damage); kept consistent with the bomber-vs-surface
//     band so a battleship can credibly deter a sub from surfacing
//     adjacent.

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';
import {
  attackableTargets,
  isVisibleTo,
  visibleUnitAt,
} from '../src/engine/queries/selectors';
import { computeDamage } from '../src/engine/systems/combat';
import { DAMAGE, UNITS } from '../src/engine/data';

// ─────────────────────────── Data integrity ──────────────────────────────────

describe('submarine: data integrity', () => {
  it('submarine appears in UNITS with the expected stats', () => {
    expect(UNITS.submarine).toBeDefined();
    expect(UNITS.submarine.cost).toBe(16000);
    expect(UNITS.submarine.move).toBe(5);
    expect(UNITS.submarine.movementClass).toBe('sea');
    expect(UNITS.submarine.minRange).toBe(1);
    expect(UNITS.submarine.maxRange).toBe(1);
    expect(UNITS.submarine.canCapture).toBe(false);
  });

  it('damage table has a complete row + column for submarine', () => {
    expect(typeof DAMAGE.submarine.battleship).toBe('number');
    expect(typeof DAMAGE.battleship.submarine).toBe('number');
    expect(typeof DAMAGE.cruiser.submarine).toBe('number');
    expect(typeof DAMAGE.infantry.submarine).toBe('number');
    expect(typeof DAMAGE.submarine.submarine).toBe('number');
  });
});

// ─────────────────────────── DIVE / SURFACE actions ──────────────────────────

describe('submarine: DIVE action', () => {
  function diveSetup() {
    // Sub on sea + dummy enemy infantry so rout doesn't end the game on
    // END_TURN. Sub starts surfaced.
    const s = makeState({
      width: 5,
      height: 3,
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 4, y: 1 } },
      ],
      tiles: [
        { pos: { x: 2, y: 1 }, terrain: 'sea' },
        { pos: { x: 3, y: 1 }, terrain: 'sea' },
      ],
      units: [
        { type: 'submarine', owner: 0, pos: { x: 2, y: 1 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 1 } },
      ],
    });
    const subId = Object.values(s.units).find((u) => u.type === 'submarine')!.id;
    return { s, subId };
  }

  it('DIVE flips submerged to true and marks hasMoved+hasActed', () => {
    const { s, subId } = diveSetup();
    expect(s.units[subId]!.submerged).toBeUndefined();
    const after = reduce(s, { type: 'DIVE', unitId: subId });
    expect(after).not.toBe(s);
    const sub = after.units[subId]!;
    expect(sub.submerged).toBe(true);
    expect(sub.hasMoved).toBe(true);
    expect(sub.hasActed).toBe(true);
  });

  it('SURFACE undoes a DIVE on a later turn', () => {
    const { s, subId } = diveSetup();
    let st = reduce(s, { type: 'DIVE', unitId: subId });
    // End turn back to player 0.
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    // hasActed reset; sub still submerged.
    expect(st.units[subId]!.submerged).toBe(true);
    expect(st.units[subId]!.hasActed).toBe(false);
    const surfaced = reduce(st, { type: 'SURFACE', unitId: subId });
    expect(surfaced).not.toBe(st);
    expect(surfaced.units[subId]!.submerged).toBe(false);
    expect(surfaced.units[subId]!.hasActed).toBe(true);
  });

  it('DIVE is rejected if the sub has already acted this turn', () => {
    const { s, subId } = diveSetup();
    // Mark hasActed manually (or via WAIT).
    const waited = reduce(s, { type: 'WAIT', unitId: subId });
    const after = reduce(waited, { type: 'DIVE', unitId: subId });
    expect(after).toBe(waited); // NO-OP, illegal
  });

  it('DIVE is rejected when the sub is already submerged', () => {
    const { s, subId } = diveSetup();
    let st = reduce(s, { type: 'DIVE', unitId: subId });
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    expect(st.units[subId]!.submerged).toBe(true);
    const after = reduce(st, { type: 'DIVE', unitId: subId });
    expect(after).toBe(st);
  });

  it('SURFACE is rejected when the sub is already surfaced', () => {
    const { s, subId } = diveSetup();
    const after = reduce(s, { type: 'SURFACE', unitId: subId });
    expect(after).toBe(s);
  });

  it('DIVE on a non-submarine is rejected', () => {
    // A tank on land + a sea tile for the sub.
    const s = makeState({
      width: 5,
      height: 2,
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 4, y: 1 } },
      ],
      units: [{ type: 'tank', owner: 0, pos: { x: 1, y: 1 } }],
    });
    const tankId = Object.keys(s.units)[0]!;
    const after = reduce(s, { type: 'DIVE', unitId: tankId });
    expect(after).toBe(s);
  });

  it('SURFACE on a non-submarine is rejected', () => {
    const s = makeState({
      width: 5,
      height: 2,
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 4, y: 1 } },
      ],
      units: [{ type: 'tank', owner: 0, pos: { x: 1, y: 1 } }],
    });
    const tankId = Object.keys(s.units)[0]!;
    const after = reduce(s, { type: 'SURFACE', unitId: tankId });
    expect(after).toBe(s);
  });
});

// ─────────────────────────── attackableTargets / stealth ─────────────────────

describe('submarine: stealth — attackableTargets', () => {
  function pairSetup(attackerType: 'cruiser' | 'submarine' | 'battleship' | 'bomber') {
    // Player-1 submarine sits at (2,0); player-0 attacker at the appropriate
    // distance (adjacent for direct, 2 away for battleship which is
    // indirect minRange=2, but here we just need the attacker to be IN range).
    // Easiest is to lay everything on a single sea row with width matching
    // the attacker's reach.
    const stats = UNITS[attackerType];
    const gap = Math.max(1, stats.minRange);
    const width = Math.max(4, gap + 2);
    const s = makeState({
      width,
      height: 2,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: width - 1, y: 1 } },
      ],
      units: [
        { type: attackerType, owner: 0, pos: { x: 0, y: 0 } },
        { type: 'submarine', owner: 1, pos: { x: gap, y: 0 } },
      ],
    });
    // HQ tiles must be land (the makeState lays HQs over the defaultTerrain,
    // so the HQ row at y=1 is a sea-replacement HQ which is unusual but
    // doesn't matter for this test — the units sit at y=0).
    const attackerId = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const subId = Object.values(s.units).find((u) => u.owner === 1)!.id;
    return { s, attackerId, subId };
  }

  it('cruiser can target an adjacent submerged enemy sub', () => {
    const { s, attackerId, subId } = pairSetup('cruiser');
    // Make the sub submerged manually so we don't burn a turn on DIVE.
    s.units[subId]!.submerged = true;
    const attacker = s.units[attackerId]!;
    const targets = attackableTargets(s, attacker);
    expect(targets.map((t) => t.id)).toContain(subId);
  });

  it('another submarine can target an adjacent submerged enemy sub', () => {
    const { s, attackerId, subId } = pairSetup('submarine');
    s.units[subId]!.submerged = true;
    const attacker = s.units[attackerId]!;
    const targets = attackableTargets(s, attacker);
    expect(targets.map((t) => t.id)).toContain(subId);
  });

  it('battleship cannot target a submerged enemy sub (filtered regardless of range)', () => {
    const { s, attackerId, subId } = pairSetup('battleship');
    s.units[subId]!.submerged = true;
    const attacker = s.units[attackerId]!;
    const targets = attackableTargets(s, attacker);
    expect(targets.map((t) => t.id)).not.toContain(subId);
  });

  it('bomber cannot target a submerged enemy sub even if adjacent in range', () => {
    const { s, attackerId, subId } = pairSetup('bomber');
    s.units[subId]!.submerged = true;
    const attacker = s.units[attackerId]!;
    const targets = attackableTargets(s, attacker);
    expect(targets.map((t) => t.id)).not.toContain(subId);
  });

  it('battleship CAN target a surfaced enemy sub', () => {
    const { s, attackerId, subId } = pairSetup('battleship');
    // No submerged flag set — sub is on the surface.
    const attacker = s.units[attackerId]!;
    const targets = attackableTargets(s, attacker);
    expect(targets.map((t) => t.id)).toContain(subId);
  });

  it('submerged sub is not listed in enemy attackableTargets even when neutral water surrounds it', () => {
    // Place a player-1 cruiser far away (out of range), a submerged sub of
    // player 0 isolated in open water, and verify the cruiser's targets are
    // empty for the submarine.
    const s = makeState({
      width: 8,
      height: 2,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 7, y: 1 } },
      ],
      units: [
        { type: 'submarine', owner: 0, pos: { x: 1, y: 0 } },
        // Enemy cruiser 5 tiles away (out of its melee range of 1).
        { type: 'cruiser', owner: 1, pos: { x: 6, y: 0 } },
      ],
    });
    const subId = Object.values(s.units).find((u) => u.owner === 0)!.id;
    s.units[subId]!.submerged = true;
    const cruiser = Object.values(s.units).find((u) => u.owner === 1)!;
    const targets = attackableTargets(s, cruiser);
    expect(targets.map((t) => t.id)).not.toContain(subId);
  });
});

// ─────────────────────────── visibleUnitAt / isVisibleTo ─────────────────────

describe('submarine: stealth — visibility predicates', () => {
  it('visibleUnitAt returns the sub when an enemy cruiser is adjacent', () => {
    // Player-0 submarine, submerged, at (3,0). Player-1 cruiser at (4,0).
    const s = makeState({
      width: 6,
      height: 2,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 5, y: 1 } },
      ],
      units: [
        { type: 'submarine', owner: 0, pos: { x: 3, y: 0 } },
        { type: 'cruiser', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const sub = Object.values(s.units).find((u) => u.type === 'submarine')!;
    s.units[sub.id]!.submerged = true;
    // From player 1's viewpoint, the sub IS visible (cruiser at d=1).
    const seenByEnemy = visibleUnitAt(s, { x: 3, y: 0 }, 1);
    expect(seenByEnemy?.id).toBe(sub.id);
    // isVisibleTo agrees.
    expect(isVisibleTo(s, sub, 1)).toBe(true);
  });

  it('visibleUnitAt hides the sub from an observer with no nearby spotter', () => {
    // Same as above but no enemy cruiser near the sub.
    const s = makeState({
      width: 6,
      height: 2,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 5, y: 1 } },
      ],
      units: [
        { type: 'submarine', owner: 0, pos: { x: 3, y: 0 } },
        // Enemy battleship far away — battleships don't spot.
        { type: 'battleship', owner: 1, pos: { x: 5, y: 0 } },
      ],
    });
    const sub = Object.values(s.units).find((u) => u.type === 'submarine')!;
    s.units[sub.id]!.submerged = true;
    const seenByEnemy = visibleUnitAt(s, { x: 3, y: 0 }, 1);
    expect(seenByEnemy).toBeUndefined();
    expect(isVisibleTo(s, sub, 1)).toBe(false);
  });

  it("own submerged sub is always visible to its owner", () => {
    const s = makeState({
      width: 4,
      height: 2,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 3, y: 1 } },
      ],
      units: [{ type: 'submarine', owner: 0, pos: { x: 2, y: 0 } }],
    });
    const sub = Object.values(s.units)[0]!;
    s.units[sub.id]!.submerged = true;
    const seenByOwner = visibleUnitAt(s, { x: 2, y: 0 }, 0);
    expect(seenByOwner?.id).toBe(sub.id);
    expect(isVisibleTo(s, sub, 0)).toBe(true);
  });

  it('an enemy submarine (any state) also acts as a spotter', () => {
    // Player-0 sub submerged; player-1 sub on a tile adjacent. P1 should see
    // the P0 sub even though both are subs.
    const s = makeState({
      width: 5,
      height: 2,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 4, y: 1 } },
      ],
      units: [
        { type: 'submarine', owner: 0, pos: { x: 2, y: 0 } },
        { type: 'submarine', owner: 1, pos: { x: 3, y: 0 } },
      ],
    });
    const p0sub = Object.values(s.units).find((u) => u.owner === 0)!;
    s.units[p0sub.id]!.submerged = true;
    expect(isVisibleTo(s, p0sub, 1)).toBe(true);
  });
});

// ─────────────────────────── Combat balance ──────────────────────────────────

describe('submarine: combat balance', () => {
  it('a full-HP cruiser one-shots a full-HP sub at melee range (>=100 damage)', () => {
    const s = makeState({
      width: 4,
      height: 2,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 3, y: 1 } },
      ],
      units: [
        { type: 'cruiser', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'submarine', owner: 1, pos: { x: 1, y: 0 } },
      ],
    });
    const cruiser = Object.values(s.units).find((u) => u.type === 'cruiser')!;
    const sub = Object.values(s.units).find((u) => u.type === 'submarine')!;
    const dealt = computeDamage(s, cruiser, sub);
    expect(dealt).toBeGreaterThanOrEqual(100);
  });

  it('a submarine vs full-HP battleship deals >= 80 damage (lethal threshold)', () => {
    const s = makeState({
      width: 4,
      height: 2,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 3, y: 1 } },
      ],
      units: [
        { type: 'submarine', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'battleship', owner: 1, pos: { x: 1, y: 0 } },
      ],
    });
    const sub = Object.values(s.units).find((u) => u.type === 'submarine')!;
    const ship = Object.values(s.units).find((u) => u.type === 'battleship')!;
    const dealt = computeDamage(s, sub, ship);
    expect(dealt).toBeGreaterThanOrEqual(80);
  });

  it('submarine deals zero damage to air units', () => {
    const s = makeState({
      width: 4,
      height: 2,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 3, y: 1 } },
      ],
      units: [
        { type: 'submarine', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'fighter', owner: 1, pos: { x: 1, y: 0 } },
      ],
    });
    const sub = Object.values(s.units).find((u) => u.type === 'submarine')!;
    const fighter = Object.values(s.units).find((u) => u.type === 'fighter')!;
    expect(computeDamage(s, sub, fighter)).toBe(0);
  });
});
