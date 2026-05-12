// Damage formula + counterattack resolution.
//
// damage = floor(base * (attackerHp/100) * (1 - 0.1 * defStars * (defHp/100)))
//
// Counter: after the primary hit, if defender is alive and not indirect (i.e.
// not artillery) and the defender's range covers the attacker's tile and the
// attacker is still alive, the defender attacks back using its new HP. The
// counterattack does NOT trigger further counterattacks.

import type { GameState, Unit } from '../core/types';
import { manhattan, tileAt } from '../core/types';
import { DAMAGE, TERRAIN, UNITS } from '../data';
import { log } from '../core/logger';

/** Compute the integer HP-damage `attacker` deals to `defender` at their current HPs and positions. */
export function computeDamage(state: GameState, attacker: Unit, defender: Unit): number {
  const base = DAMAGE[attacker.type][defender.type];
  const def = tileAt(state.map, defender.pos);
  const stars = TERRAIN[def.terrain].defenseStars;
  const raw =
    base * (attacker.hp / 100) * (1 - 0.1 * stars * (defender.hp / 100));
  return Math.max(0, Math.floor(raw));
}

/** True if `attacker` can reach `defender` for an ATTACK at current positions. */
export function inAttackRange(attacker: Unit, defender: Unit): boolean {
  const stats = UNITS[attacker.type];
  const d = manhattan(attacker.pos, defender.pos);
  return d >= stats.minRange && d <= stats.maxRange;
}

export type CombatResult = {
  attackerDealt: number; // hp removed from defender by primary
  defenderDealt: number; // hp removed from attacker by counter, 0 if none
  defenderDestroyed: boolean;
  attackerDestroyed: boolean;
  countered: boolean;
};

/**
 * Predict the damage exchange of an ATTACK without mutating state. The result
 * (`dealt`, `counterReceived`) must match what `resolveAttack` actually applies
 * for the same inputs — both functions share the `computeDamage` primitive so
 * the renderer's hover tooltip stays in sync with what the reducer commits.
 *
 * Pure: does not read or write any state.units entries beyond the lookup of
 * the two ids. Returns zeros if either unit is missing or the target is
 * friendly.
 */
export function previewAttack(
  state: GameState,
  attackerId: string,
  targetId: string,
): { dealt: number; counterReceived: number } {
  const attacker = state.units[attackerId];
  const defender = state.units[targetId];
  if (!attacker || !defender) return { dealt: 0, counterReceived: 0 };
  if (attacker.owner === defender.owner) return { dealt: 0, counterReceived: 0 };

  const dealt = computeDamage(state, attacker, defender);
  const defHpAfter = Math.max(0, Math.min(100, defender.hp - dealt));
  if (defHpAfter === 0) return { dealt, counterReceived: 0 };

  // Counter logic mirrors `resolveAttack`. Indirect defenders never counter.
  const defStats = UNITS[defender.type];
  if (defStats.indirect) return { dealt, counterReceived: 0 };
  if (!inAttackRange(defender, attacker)) return { dealt, counterReceived: 0 };

  // Counter damage uses the defender's POST-hit HP — we must simulate the hit
  // without mutating the real defender.
  const defenderAfter: Unit = { ...defender, hp: defHpAfter };
  const counter = computeDamage(state, defenderAfter, attacker);
  return { dealt, counterReceived: counter };
}

/**
 * Mutates the given state's units in-place. Callers are expected to pass a
 * fresh deep clone (the reducer does this). Returns a summary for logging.
 */
export function resolveAttack(
  state: GameState,
  attacker: Unit,
  defender: Unit,
): CombatResult {
  const dealt = computeDamage(state, attacker, defender);
  defender.hp = Math.max(0, Math.min(100, defender.hp - dealt));
  log('engine', 'damage calculated', {
    attacker: attacker.id,
    defender: defender.id,
    dealt,
    defenderHp: defender.hp,
  });

  const result: CombatResult = {
    attackerDealt: dealt,
    defenderDealt: 0,
    defenderDestroyed: false,
    attackerDestroyed: false,
    countered: false,
  };

  if (defender.hp === 0) {
    result.defenderDestroyed = true;
    log('engine', 'unit destroyed', { id: defender.id, type: defender.type });
    return result;
  }

  // Counter? Indirect (artillery) cannot counter.
  const defStats = UNITS[defender.type];
  if (defStats.indirect) return result;
  if (!inAttackRange(defender, attacker)) return result;

  const counter = computeDamage(state, defender, attacker);
  attacker.hp = Math.max(0, Math.min(100, attacker.hp - counter));
  result.defenderDealt = counter;
  result.countered = true;
  log('engine', 'counterattack', {
    defender: defender.id,
    attacker: attacker.id,
    dealt: counter,
    attackerHp: attacker.hp,
  });

  if (attacker.hp === 0) {
    result.attackerDestroyed = true;
    log('engine', 'unit destroyed', { id: attacker.id, type: attacker.type });
  }
  return result;
}
