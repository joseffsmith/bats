// Shared orchestration: given an ATTACK action and a state snapshot, enqueue
// all the parallel + blocking animations that make a hit feel weighty
// (projectile + flash + impact via AttackAnim, shake, HP tweens, damage
// labels, hit pause, and death anims).
//
// Lives in the renderer layer because the engine knows nothing about
// animations. Both input.ts (player attacks) and ai-driver.ts (AI attacks)
// call this so the visual treatment is identical.

import type { GameState, UnitId } from '../engine/core/types';
import { UNITS } from '../engine/data';
import { previewAttack } from '../engine/systems/combat';
import type { AnimationQueue } from './animations';
import {
  ATTACK_ARC_MS,
  ATTACK_MS,
  HIT_PAUSE_MS,
  HIT_PAUSE_THRESHOLD_HP,
  PROJECTILE_FRACTION,
} from './animations';

/**
 * The fraction of the attack duration after which the projectile lands and
 * the impact registers. Direct fire lands at PROJECTILE_FRACTION (0.45); the
 * indirect-fire arc takes slightly longer (0.70) — see drawAttackEffects.
 */
function impactFractionFor(arc: boolean): number {
  return arc ? 0.70 : PROJECTILE_FRACTION;
}

export function enqueueAttackEffects(
  anim: AnimationQueue,
  state: GameState,
  attackerId: UnitId,
  targetId: UnitId,
): void {
  const attacker = state.units[attackerId];
  const target = state.units[targetId];
  if (!attacker || !target) return;
  const dmg = previewAttack(state, attackerId, targetId);
  const arc = UNITS[attacker.type].indirect;
  const attackDuration = arc ? ATTACK_ARC_MS : ATTACK_MS;
  const impactDelay = attackDuration * impactFractionFor(arc);

  // Master attack anim — drives projectile + muzzle flash + impact via the
  // canvas effect-draw routine.
  anim.enqueueAttack(attackerId, targetId, {
    attackerPos: attacker.pos,
    targetPos: target.pos,
    damageDealt: dmg.dealt,
    counterReceived: dmg.counterReceived,
    arc,
  });

  const targetFinalHp = Math.max(0, target.hp - dmg.dealt);
  const attackerFinalHp = Math.max(0, attacker.hp - dmg.counterReceived);

  // Camera shake when either side takes a >40 HP hit — aligned with impact.
  if (dmg.dealt > 40 || dmg.counterReceived > 40) {
    anim.enqueueShake(undefined, impactDelay);
  }

  // HP tweens slide WITH impact, not from attack start, so the bar visibly
  // reacts to the hit rather than pre-emptively draining mid-flight.
  if (targetFinalHp > 0 && dmg.dealt > 0) {
    anim.enqueueHpTween(target.id, target.hp, targetFinalHp, impactDelay);
  }
  if (attackerFinalHp > 0 && dmg.counterReceived > 0) {
    // Counter lands after the primary impact + a short beat.
    anim.enqueueHpTween(
      attacker.id,
      attacker.hp,
      attackerFinalHp,
      impactDelay + 120,
    );
  }

  // Floating damage labels.
  if (dmg.dealt > 0) {
    anim.enqueueDamageLabel(
      target.pos,
      dmg.dealt,
      dmg.dealt > HIT_PAUSE_THRESHOLD_HP,
      impactDelay,
    );
  }
  if (dmg.counterReceived > 0) {
    anim.enqueueDamageLabel(
      attacker.pos,
      dmg.counterReceived,
      dmg.counterReceived > HIT_PAUSE_THRESHOLD_HP,
      impactDelay + 120,
    );
  }

  // Hit pause: a brief queue stall after a heavy hit, before death/next anim.
  // Triggered only on the heaviest exchanges so it doesn't muddy normal play.
  if (dmg.dealt > HIT_PAUSE_THRESHOLD_HP || dmg.counterReceived > HIT_PAUSE_THRESHOLD_HP) {
    anim.enqueueHitPause(HIT_PAUSE_MS);
  }

  // Deaths come after the attack window (and any hit pause) so the fade
  // plays AFTER the impact reads.
  if (targetFinalHp <= 0) {
    anim.enqueueDeath(target.id, target.pos);
  } else if (attackerFinalHp <= 0) {
    anim.enqueueDeath(attacker.id, attacker.pos);
  }
}
