// Combat acceptance: damage formula, counters (post-damage HP), kill
// resolution, range gating, action-flag gating.

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';
import { computeDamage, resolveAttack } from '../src/engine/systems/combat';

// Helper: minimal 2-unit setup on flat terrain. Attacker is placed on
// (1,1) — a road tile (0 stars) — so counterattack math doesn't pick up
// the attacker's HQ defense stars unintentionally. Defender at (1 + dist, 1).
function pair(
  attackerType: 'infantry' | 'recon' | 'tank' | 'artillery' | 'copter',
  defenderType: 'infantry' | 'recon' | 'tank' | 'artillery' | 'copter',
  opts: {
    atkHp?: number;
    defHp?: number;
    defenderTerrain?:
      | 'plain'
      | 'road'
      | 'forest'
      | 'mountain'
      | 'sea'
      | 'city'
      | 'hq'
      | 'factory';
    dist?: number;
  } = {},
) {
  const dist = opts.dist ?? 1;
  const width = 1 + dist + 2;
  const s = makeState({
    width,
    height: 2,
    defaultTerrain: 'road',
    hqs: [
      { owner: 0, pos: { x: 0, y: 0 } },
      { owner: 1, pos: { x: width - 1, y: 0 } },
    ],
    tiles: opts.defenderTerrain
      ? [{ pos: { x: 1 + dist, y: 1 }, terrain: opts.defenderTerrain }]
      : [],
    units: [
      { type: attackerType, owner: 0, pos: { x: 1, y: 1 }, hp: opts.atkHp ?? 100 },
      { type: defenderType, owner: 1, pos: { x: 1 + dist, y: 1 }, hp: opts.defHp ?? 100 },
    ],
  });
  const a = Object.values(s.units).find((u) => u.owner === 0)!;
  const d = Object.values(s.units).find((u) => u.owner === 1)!;
  return { s, a, d };
}

describe('combat: damage formula numeric assertions', () => {
  // PLAN.md formula:
  //   floor(base * (atkHp/100) * (1 - 0.1 * defStars * (defHp/100)))
  // Use defender on 'road' (0 stars) and 'forest' (2 stars) to vary stars.

  it('tank → tank on road (0 stars) full HP: floor(55*1.0*(1-0)) = 55', () => {
    const { s, a, d } = pair('tank', 'tank');
    expect(computeDamage(s, a, d)).toBe(55);
  });

  it('infantry → tank on road full HP: floor(5*1*1) = 5', () => {
    const { s, a, d } = pair('infantry', 'tank');
    expect(computeDamage(s, a, d)).toBe(5);
  });

  it('artillery → infantry on road full HP: floor(90*1*1) = 90', () => {
    const { s, a, d } = pair('artillery', 'infantry', { dist: 2 });
    expect(computeDamage(s, a, d)).toBe(90);
  });

  it('tank → infantry on forest (2 stars) full HP: floor(75*1*(1-0.2)) = 60', () => {
    const { s, a, d } = pair('tank', 'infantry', { defenderTerrain: 'forest' });
    expect(computeDamage(s, a, d)).toBe(60);
  });

  it('tank (50 HP) → infantry on plain (1 star) full HP: floor(75*0.5*0.9) = 33', () => {
    const { s, a, d } = pair('tank', 'infantry', {
      atkHp: 50,
      defenderTerrain: 'plain',
    });
    expect(computeDamage(s, a, d)).toBe(33);
  });

  it('copter → tank on city (3 stars), tank at 50 HP: floor(25*1*(1-0.15)) = 21', () => {
    const { s, a, d } = pair('copter', 'tank', {
      defHp: 50,
      defenderTerrain: 'city',
    });
    // raw = 25 * 1 * (1 - 0.1*3*0.5) = 25 * 0.85 = 21.25 → floor 21
    expect(computeDamage(s, a, d)).toBe(21);
  });

  it('artillery → tank on mountain (4 stars), defender full HP: floor(70*1*(1-0.4)) = 42', () => {
    const { s, a, d } = pair('artillery', 'tank', {
      defenderTerrain: 'mountain',
      dist: 2,
    });
    expect(computeDamage(s, a, d)).toBe(42);
  });
});

describe('combat: counterattacks', () => {
  it('tank vs tank: both survive, counter triggers, counter uses post-damage HP', () => {
    // attacker (tank, 100hp) vs defender (tank, 100hp) on road (0 stars).
    // primary: floor(55 * 1 * 1) = 55 → defender at 45
    // counter: defender(45) on road (0 stars) vs attacker on road (0 stars):
    //   floor(55 * 0.45 * 1) = 24
    const { s, a, d } = pair('tank', 'tank');
    const clone = structuredClone(s);
    const ac = clone.units[a.id]!;
    const dc = clone.units[d.id]!;
    const res = resolveAttack(clone, ac, dc);
    expect(res.attackerDealt).toBe(55);
    expect(dc.hp).toBe(45);
    expect(res.countered).toBe(true);
    expect(res.defenderDealt).toBe(24);
    expect(ac.hp).toBe(76);
  });

  it('no counter when defender dies', () => {
    // Tank vs infantry on road; infantry at 30 HP.
    // primary damage = floor(75 * 1 * 1) = 75 → infantry would go to -45 → clipped 0 (dead).
    const { s, a, d } = pair('tank', 'infantry', { defHp: 30 });
    const clone = structuredClone(s);
    const ac = clone.units[a.id]!;
    const dc = clone.units[d.id]!;
    const res = resolveAttack(clone, ac, dc);
    expect(res.defenderDestroyed).toBe(true);
    expect(res.countered).toBe(false);
    expect(res.defenderDealt).toBe(0);
    // Attacker untouched.
    expect(ac.hp).toBe(100);
  });

  it('artillery (indirect) never counters even when defender is in melee range', () => {
    // Set up an attacking tank that strikes an adjacent artillery; the artillery should NOT counter.
    const s = makeState({
      width: 3,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        { type: 'tank', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'artillery', owner: 1, pos: { x: 1, y: 0 } },
      ],
    });
    const tank = Object.values(s.units).find((u) => u.type === 'tank')!;
    const art = Object.values(s.units).find((u) => u.type === 'artillery')!;
    const clone = structuredClone(s);
    const tc = clone.units[tank.id]!;
    const ac = clone.units[art.id]!;
    const res = resolveAttack(clone, tc, ac);
    // tank → artillery on road: floor(70 * 1 * 1) = 70 → defender 30 HP (alive)
    expect(ac.hp).toBe(30);
    // Artillery is indirect → never counters, even if defender survives & in adjacent range.
    expect(res.countered).toBe(false);
    expect(tc.hp).toBe(100);
  });

  it('attacker dies on counter: attacker removed from state.units', () => {
    // Set up so attacker dies. tank (5 HP) attacks tank (100 HP) on road:
    //   primary: floor(55 * 0.05 * 1) = 2 → defender 98 HP
    //   counter: defender(98) → attacker on road (0 stars):
    //            floor(55 * 0.98 * 1) = floor(53.9) = 53 → attacker at -48 → 0 (dead)
    const { s, a, d } = pair('tank', 'tank', { atkHp: 5 });
    const next = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: d.id });
    expect(next.units[a.id]).toBeUndefined();
    // Defender survived.
    expect(next.units[d.id]).toBeDefined();
    expect(next.units[d.id]!.hp).toBe(98);
  });

  it('artillery cannot ATTACK if it has already moved this turn (move-and-attack blocked)', () => {
    // Place artillery; first MOVE it one tile; then attempt ATTACK on tank in range.
    const s = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [
        { type: 'artillery', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'tank', owner: 1, pos: { x: 3, y: 0 } },
      ],
    });
    const art = Object.values(s.units).find((u) => u.type === 'artillery')!;
    const tank = Object.values(s.units).find((u) => u.type === 'tank')!;
    // Move artillery one tile right (now at x=1).
    const moved = reduce(s, {
      type: 'MOVE',
      unitId: art.id,
      path: [{ x: 1, y: 0 }],
    });
    expect(moved.units[art.id]!.pos.x).toBe(1);
    // Try ATTACK — distance 2, within range, but indirect+hasMoved blocks.
    const after = reduce(moved, {
      type: 'ATTACK',
      attackerId: art.id,
      targetId: tank.id,
    });
    expect(after).toBe(moved); // no-op
    expect(after.units[tank.id]!.hp).toBe(100);
  });

  it('attacker cannot ATTACK if it has already acted', () => {
    const { s, a, d } = pair('tank', 'tank');
    const once = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: d.id });
    expect(once.units[a.id]!.hasActed).toBe(true);
    // Attempt second attack same turn.
    const twice = reduce(once, {
      type: 'ATTACK',
      attackerId: a.id,
      targetId: d.id,
    });
    expect(twice).toBe(once);
  });
});

describe('combat: range gating', () => {
  it('artillery attacks at distance 2 and 3 but not 1 or 4', () => {
    const make = (dist: number) =>
      makeState({
        width: dist + 2,
        height: 1,
        defaultTerrain: 'road',
        hqs: [
          { owner: 0, pos: { x: 0, y: 0 } },
          { owner: 1, pos: { x: dist + 1, y: 0 } },
        ],
        units: [
          { type: 'artillery', owner: 0, pos: { x: 0, y: 0 } },
          { type: 'tank', owner: 1, pos: { x: dist, y: 0 } },
        ],
      });
    for (const [dist, expectHit] of [
      [1, false],
      [2, true],
      [3, true],
      [4, false],
    ] as const) {
      const st = make(dist);
      const art = Object.values(st.units).find((u) => u.type === 'artillery')!;
      const tank = Object.values(st.units).find((u) => u.type === 'tank')!;
      const after = reduce(st, {
        type: 'ATTACK',
        attackerId: art.id,
        targetId: tank.id,
      });
      const hit = after.units[tank.id]!.hp < 100;
      expect(hit).toBe(expectHit);
    }
  });

  it('direct unit (tank) cannot ATTACK at distance 2', () => {
    const { s, a, d } = pair('tank', 'tank', { dist: 2 });
    const after = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: d.id });
    expect(after).toBe(s);
  });
});

describe('combat: kill resolution removes units from state', () => {
  it('defender dies → state.units no longer contains defender', () => {
    const { s, a, d } = pair('tank', 'infantry', { defHp: 30 });
    const next = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: d.id });
    expect(next.units[d.id]).toBeUndefined();
    // Attacker is alive and now has hasMoved & hasActed.
    expect(next.units[a.id]!.hasActed).toBe(true);
    expect(next.units[a.id]!.hasMoved).toBe(true);
  });

  it('cannot attack a friendly unit', () => {
    const s = makeState({
      width: 3,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        { type: 'tank', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const tank = Object.values(s.units).find((u) => u.type === 'tank')!;
    const friend = Object.values(s.units).find(
      (u) => u.owner === 0 && u.type === 'infantry',
    )!;
    const next = reduce(s, {
      type: 'ATTACK',
      attackerId: tank.id,
      targetId: friend.id,
    });
    expect(next).toBe(s);
  });

  it('cannot attack an unknown target id', () => {
    const { s, a } = pair('tank', 'tank');
    const next = reduce(s, {
      type: 'ATTACK',
      attackerId: a.id,
      targetId: 'no-such-unit',
    });
    expect(next).toBe(s);
  });

  it('cannot attack with an unknown attacker id', () => {
    const { s, d } = pair('tank', 'tank');
    const next = reduce(s, {
      type: 'ATTACK',
      attackerId: 'no-such-unit',
      targetId: d.id,
    });
    expect(next).toBe(s);
  });
});
