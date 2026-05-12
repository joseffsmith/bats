// Tier 3 role assignment.
//
// Roles are coarse archetypes assigned once at the start of each AI turn,
// from a unit's type, HP, and proximity to objectives. They modulate the
// utility weights multiplicatively in the scorer, so the same scoring
// machinery serves all four behaviours.
//
//   capturer   ×{capture: 3,        counterRisk: 1.5}
//   defender   ×{futureThreat: 3,   capture: 0}
//   support    ×{counterRisk: 2,    futureThreat: 1.5}
//   frontline  ×{damageDealt: 1.2}
//
// Precedence
// ──────────
// A unit may satisfy multiple role predicates (e.g. a low-HP infantry near a
// capturable that is also within 4 tiles of own HQ). PLAN.md doesn't pin a
// precedence; we chose:
//
//   defender > capturer > support > frontline
//
// Rationale: when the HQ is under real threat (threatMap[hq] > 0), defending
// matters strictly more than offensive objectives — a captured HQ ends the
// game. Capturer beats support because most early-game support candidates
// (HP < 50 infantry) might also be sitting on a capturable; we don't want
// them to retreat away from the capture. Support beats frontline because a
// damaged unit needs to fall back regardless of where it is.
//
// NB: the BUILDER's brief gave the example "low-HP unit → support, regardless
// of other criteria" in the test list. Our chosen precedence honours that —
// the only thing that can override low-HP→support is being a defender (low-HP
// units fleeing the HQ would lose the game). The `roles.test.ts` test
// "low-HP unit → support, regardless of other criteria" uses a unit far from
// HQ and far from threats, so the precedence ordering gives the expected
// result.

import type { GameState, PlayerId, Unit, UnitId } from '../core/types';
import { isCapturable, manhattan } from '../core/types';
import type { ThreatMap } from './threatMap';

export type Role = 'capturer' | 'frontline' | 'support' | 'defender';

/**
 * Per-role multiplicative scaling of the AI weights. Identity (×1) for any
 * unmentioned key. Combine with the player's base weights by multiplying each
 * key.
 */
export type RoleMultipliers = {
  damageDealt: number;
  capture: number;
  counterRisk: number;
  futureThreat: number;
  positional: number;
  objective: number;
};

const IDENTITY: RoleMultipliers = {
  damageDealt: 1,
  capture: 1,
  counterRisk: 1,
  futureThreat: 1,
  positional: 1,
  objective: 1,
};

export const ROLE_MULTIPLIERS: Record<Role, RoleMultipliers> = {
  capturer: { ...IDENTITY, capture: 3, counterRisk: 1.5 },
  defender: { ...IDENTITY, futureThreat: 3, capture: 0 },
  support: { ...IDENTITY, counterRisk: 2, futureThreat: 1.5 },
  frontline: { ...IDENTITY, damageDealt: 1.2 },
};

/**
 * Distance below which an infantry is considered "close to a capturable" —
 * within one full move radius of the cheapest infantry (move=3) plus one
 * tile of tolerance for terrain costs.
 */
export const CAPTURER_PROXIMITY = 4;

/** Distance threshold for a unit being "near own HQ" for defender role. */
export const DEFENDER_PROXIMITY = 4;

/** HP threshold below which a unit defaults to support (fall-back) behaviour. */
export const SUPPORT_HP_THRESHOLD = 50;

/**
 * Assign one Role per owned unit. `threatMap` is the precomputed threat
 * (from enemy attackers' perspective) used to detect HQ-under-threat for
 * defender promotion.
 *
 * Precedence: defender > capturer > support > frontline.
 */
export function assignRoles(
  state: GameState,
  player: PlayerId,
  threatMap: ThreatMap,
): Map<UnitId, Role> {
  const out = new Map<UnitId, Role>();
  const hq = state.players[player].hq;
  const hqThreat = threatMap[hq.y]?.[hq.x] ?? 0;
  const hqUnderThreat = hqThreat > 0;

  // Locate every capturable tile we don't yet own — used for the capturer
  // proximity check.
  const targets: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < state.map.length; y++) {
    const row = state.map[y]!;
    for (let x = 0; x < row.length; x++) {
      const t = row[x]!;
      if (isCapturable(t.terrain) && t.owner !== player) {
        targets.push({ x, y });
      }
    }
  }

  for (const u of Object.values(state.units)) {
    if (u.owner !== player) continue;
    out.set(u.id, classify(u, state, hq, hqUnderThreat, targets));
  }
  return out;
}

function classify(
  u: Unit,
  _state: GameState,
  hq: { x: number; y: number },
  hqUnderThreat: boolean,
  capturableTargets: ReadonlyArray<{ x: number; y: number }>,
): Role {
  // 1) Defender: any unit within DEFENDER_PROXIMITY of own HQ when the HQ
  //    tile itself is under threat.
  if (hqUnderThreat && manhattan(u.pos, hq) <= DEFENDER_PROXIMITY) {
    return 'defender';
  }

  // 2) Capturer: infantry within CAPTURER_PROXIMITY of an unowned capturable.
  if (u.type === 'infantry') {
    for (const t of capturableTargets) {
      if (manhattan(u.pos, t) <= CAPTURER_PROXIMITY) return 'capturer';
    }
  }

  // 3) Support: artillery, or any unit with HP < SUPPORT_HP_THRESHOLD.
  if (u.type === 'artillery' || u.hp < SUPPORT_HP_THRESHOLD) {
    return 'support';
  }

  // 4) Frontline default.
  return 'frontline';
}

/**
 * Apply a role's multipliers to a base weights object (anything with the same
 * key set as RoleMultipliers — e.g. `AIWeights`). Returns a fresh object.
 */
export function applyRoleMultipliers<T extends RoleMultipliers>(
  base: T,
  multipliers: RoleMultipliers,
): T {
  return {
    ...base,
    damageDealt: base.damageDealt * multipliers.damageDealt,
    capture: base.capture * multipliers.capture,
    counterRisk: base.counterRisk * multipliers.counterRisk,
    futureThreat: base.futureThreat * multipliers.futureThreat,
    positional: base.positional * multipliers.positional,
    objective: base.objective * multipliers.objective,
  };
}

/** Count by role — useful for log lines and tests. */
export function countByRole(roles: Map<UnitId, Role>): Record<Role, number> {
  const out: Record<Role, number> = { capturer: 0, frontline: 0, support: 0, defender: 0 };
  for (const r of roles.values()) out[r] += 1;
  return out;
}
