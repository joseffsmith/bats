import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { computeDamage, resolveAttack } from '../src/engine/systems/combat';
import { reduce } from '../src/engine/core/reducer';

describe('combat', () => {
  it('damage formula: tank vs tank on plain (1 star) = floor(55 * 1 * (1 - 0.1*1*1)) = 49', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        { type: 'tank', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'tank', owner: 1, pos: { x: 1, y: 0 } },
      ],
    });
    const [a, t] = Object.values(s.units);
    const dmg = computeDamage(s, a!, t!);
    // Standing on 'plain' (1 star) per data-inline; the HQ tile only applies if defender is on HQ.
    // a at (0,0)=hq, t at (1,0)=plain → defender on plain (stars=1) at full HP.
    // 55 * 1.0 * (1 - 0.1*1*1.0) = 55 * 0.9 = 49.5 → floor 49
    expect(dmg).toBe(49);
  });

  it('counterattack triggers when defender survives and is in range', () => {
    const s = makeState({
      width: 3,
      height: 1,
      defaultTerrain: 'road', // 0 stars to keep numbers clean
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        { type: 'tank', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'tank', owner: 1, pos: { x: 1, y: 0 } },
      ],
    });
    const clone = structuredClone(s);
    const a = clone.units[Object.keys(clone.units)[0]!]!;
    const t = clone.units[Object.keys(clone.units)[1]!]!;
    // Attacker on hq has its OWN defenseStars (4) but combat looks at defender's tile only.
    // Defender on road (0 stars) full HP: damage = floor(55 * 1.0 * (1 - 0)) = 55 → defender 45 hp.
    // Counter: defender (45 hp) on road vs attacker on hq (4 stars), attacker hp 100:
    //   floor(55 * 0.45 * (1 - 0.1*4*1.0)) = floor(55*0.45*0.6) = floor(14.85) = 14
    const res = resolveAttack(clone, a, t);
    expect(res.attackerDealt).toBe(55);
    expect(t.hp).toBe(45);
    expect(res.countered).toBe(true);
    expect(res.defenderDealt).toBe(14);
    expect(a.hp).toBe(86);
  });

  it('artillery does not provoke a counter (indirect) and cannot be countered at range 2', () => {
    const s = makeState({
      width: 4,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      units: [
        { type: 'artillery', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'tank', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const artId = Object.keys(s.units)[0]!;
    const tankId = Object.keys(s.units)[1]!;
    const next = reduce(s, { type: 'ATTACK', attackerId: artId, targetId: tankId });
    // Artillery survives at full HP — no counter possible.
    expect(next.units[artId]!.hp).toBe(100);
    // Tank took damage.
    expect(next.units[tankId]!.hp).toBeLessThan(100);
  });

  it('lethal attack removes the defender unit from state', () => {
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
        { type: 'infantry', owner: 1, pos: { x: 1, y: 0 }, hp: 30 },
      ],
    });
    const a = Object.values(s.units).find((u) => u.type === 'tank')!;
    const t = Object.values(s.units).find((u) => u.type === 'infantry')!;
    const next = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: t.id });
    expect(next.units[t.id]).toBeUndefined();
  });
});
