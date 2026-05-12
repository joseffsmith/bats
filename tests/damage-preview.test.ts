// previewAttack contract: the renderer's hover tooltip must show the EXACT
// damage the engine commits. We brute-force the matrix of attacker × defender
// pairs (skipping range mismatches) and additionally probe a handful of HP /
// defence-star configurations to catch off-by-one rounding.

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { previewAttack } from '../src/engine/systems/combat';
import { reduce } from '../src/engine/core/reducer';
import type { TerrainType, UnitType } from '../src/engine/core/types';

const MELEE_TYPES: UnitType[] = ['infantry', 'recon', 'tank', 'copter'];

/**
 * Build a 1-row map with attacker at x=0 and defender at x=`gap` on
 * `defenderTerrain` (everything else plain). Caller chooses the gap to land
 * the defender at a valid Manhattan distance for the attacker type.
 */
function buildPair(opts: {
  attacker: UnitType;
  defender: UnitType;
  defenderTerrain: TerrainType;
  attackerHp?: number;
  defenderHp?: number;
  gap?: number;
}): ReturnType<typeof makeState> {
  const gap = opts.gap ?? 1;
  const width = Math.max(3, gap + 2);
  // Both HQs need separate slots; place them outside the combat span so
  // terrain/defence is what we expect.
  const hqAY = 1;
  const hqBY = 1;
  return makeState({
    width,
    height: 3,
    defaultTerrain: 'road', // 0 stars so attacker tile contributes nothing weird
    hqs: [
      { owner: 0, pos: { x: 0, y: hqAY } },
      { owner: 1, pos: { x: width - 1, y: hqBY } },
    ],
    tiles: [{ pos: { x: gap, y: 0 }, terrain: opts.defenderTerrain }],
    units: [
      {
        type: opts.attacker,
        owner: 0,
        pos: { x: 0, y: 0 },
        ...(opts.attackerHp !== undefined ? { hp: opts.attackerHp } : {}),
      },
      {
        type: opts.defender,
        owner: 1,
        pos: { x: gap, y: 0 },
        ...(opts.defenderHp !== undefined ? { hp: opts.defenderHp } : {}),
      },
    ],
  });
}

describe('previewAttack', () => {
  it('matches actual damage for every melee attacker × defender pair on plain', () => {
    for (const attacker of MELEE_TYPES) {
      for (const defender of MELEE_TYPES) {
        const s = buildPair({ attacker, defender, defenderTerrain: 'plain' });
        const a = Object.values(s.units).find((u) => u.owner === 0)!;
        const t = Object.values(s.units).find((u) => u.owner === 1)!;
        const preview = previewAttack(s, a.id, t.id);
        const next = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: t.id });
        const tAfter = next.units[t.id];
        const dealtActual = tAfter ? t.hp - tAfter.hp : t.hp;
        expect({ pair: `${attacker} vs ${defender}`, dealt: preview.dealt }).toEqual({
          pair: `${attacker} vs ${defender}`,
          dealt: dealtActual,
        });
      }
    }
  });

  it('preview matches actual across terrain defence stars (road 0 → mountain 4)', () => {
    const terrains: TerrainType[] = ['road', 'plain', 'forest', 'city', 'mountain'];
    for (const terrain of terrains) {
      // Attacker = infantry (move-class foot, can stand on mountain), defender = infantry.
      const s = buildPair({
        attacker: 'infantry',
        defender: 'infantry',
        defenderTerrain: terrain,
      });
      const a = Object.values(s.units).find((u) => u.owner === 0)!;
      const t = Object.values(s.units).find((u) => u.owner === 1)!;
      const preview = previewAttack(s, a.id, t.id);
      const next = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: t.id });
      const tAfter = next.units[t.id];
      const dealtActual = tAfter ? t.hp - tAfter.hp : t.hp;
      expect({ terrain, dealt: preview.dealt }).toEqual({ terrain, dealt: dealtActual });
    }
  });

  it('preview matches actual at low HP (attacker 30 vs defender 50, road)', () => {
    const s = buildPair({
      attacker: 'tank',
      defender: 'tank',
      defenderTerrain: 'road',
      attackerHp: 30,
      defenderHp: 50,
    });
    const a = Object.values(s.units).find((u) => u.owner === 0)!;
    const t = Object.values(s.units).find((u) => u.owner === 1)!;
    const preview = previewAttack(s, a.id, t.id);
    const next = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: t.id });
    const tAfter = next.units[t.id];
    const aAfter = next.units[a.id];
    const dealtActual = tAfter ? t.hp - tAfter.hp : t.hp;
    const counterActual = aAfter ? a.hp - aAfter.hp : a.hp;
    expect(preview.dealt).toBe(dealtActual);
    expect(preview.counterReceived).toBe(counterActual);
  });

  it('artillery preview returns counterReceived=0 (indirect cannot be countered out of range)', () => {
    const s = buildPair({
      attacker: 'artillery',
      defender: 'tank',
      defenderTerrain: 'road',
      gap: 2,
    });
    const a = Object.values(s.units).find((u) => u.owner === 0)!;
    const t = Object.values(s.units).find((u) => u.owner === 1)!;
    const preview = previewAttack(s, a.id, t.id);
    expect(preview.counterReceived).toBe(0);
    const next = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: t.id });
    const aAfter = next.units[a.id];
    expect(aAfter!.hp).toBe(a.hp);
    const tAfter = next.units[t.id]!;
    expect(t.hp - tAfter.hp).toBe(preview.dealt);
  });

  it('previewing a lethal attack reports counterReceived=0 (no counter when defender dies)', () => {
    const s = buildPair({
      attacker: 'tank',
      defender: 'infantry',
      defenderTerrain: 'road',
      defenderHp: 20,
    });
    const a = Object.values(s.units).find((u) => u.owner === 0)!;
    const t = Object.values(s.units).find((u) => u.owner === 1)!;
    const preview = previewAttack(s, a.id, t.id);
    expect(preview.dealt).toBeGreaterThanOrEqual(20);
    expect(preview.counterReceived).toBe(0);
    const next = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: t.id });
    expect(next.units[t.id]).toBeUndefined();
    expect(next.units[a.id]!.hp).toBe(a.hp);
  });

  it('zeroes for friendly target', () => {
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
        { type: 'tank', owner: 0, pos: { x: 1, y: 0 } },
      ],
    });
    const [a, b] = Object.values(s.units);
    const preview = previewAttack(s, a!.id, b!.id);
    expect(preview).toEqual({ dealt: 0, counterReceived: 0 });
  });

  it('zeroes for unknown ids', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    expect(previewAttack(s, 'nope1', 'nope2')).toEqual({ dealt: 0, counterReceived: 0 });
  });
});
