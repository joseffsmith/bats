// Tier 1 utility-scoring AI.
//
// For each owned unit (cost descending, ties by id), enumerate all
// `(MOVE destination, follow-up)` pairs reachable this turn and score them
// with `scoreAction`. Apply the highest-scoring candidate with score > 0.
// When no positive-scored action remains for any unit, emit END_TURN.
//
// This is the "greedy unit-by-unit utility" planner spelled out in PLAN.md.
// It is intentionally NOT a search — no minimax, no rollout. The whole
// premise of the project is that good design lives in the weights; if the
// weights are right, greedy beats random comfortably and is the floor the
// later threat-map AI builds on.

import type {
  Action,
  Coord,
  GameState,
  PlayerId,
  Unit,
  UnitId,
  UnitType,
} from '../core/types';
import {
  coordEq,
  inBounds,
  isCapturable,
  manhattan,
  otherPlayer,
  tileAt,
} from '../core/types';
import { reduce } from '../core/reducer';
import { isLegalAction } from '../core/validators';
import { TERRAIN, UNITS, AI_WEIGHTS, CAPTURE_THRESHOLD } from '../data';
import type { AIWeights } from '../data/loader';
import { log, isLogEnabled } from '../core/logger';
import { computeDamage, inAttackRange } from '../systems/combat';
import { generateCandidates } from './candidates';
import type { Candidate } from './candidates';
import type { AIContext, AIFactory } from './types';
import { computeThreatMap, computeValueMap } from './threatMap';
import type { ThreatMap, ValueMap } from './threatMap';
import { hiddenTiles, viewStateForPlayer } from '../queries/selectors';
import {
  ROLE_MULTIPLIERS,
  applyRoleMultipliers,
  assignRoles,
  countByRole,
} from './roles';
import type { Role, RoleMultipliers } from './roles';

// Soft cap on actions per turn so a bug can't infinite-loop the runner.
const ACTION_STEP_CAP = 200;

/** Re-export for callers that want the default. */
export const DEFAULT_AI_WEIGHTS: AIWeights = AI_WEIGHTS;

/** Weight on the valueMap term inside positionalValue when `useThreatMap` is on. */
const VALUE_MAP_WEIGHT = 0.1;

/**
 * Bonus magnitude added to `objectiveBonus` when a candidate moves the unit
 * toward its role objective. PLAN.md specifies +3.
 */
const OBJECTIVE_BONUS = 3;

/**
 * Soft cap on Tier-3 owned-unit count to keep per-turn AI time under the
 * 200ms budget. With >20 units acting twice per turn the scoring loop on a
 * 16×10 map blows past 200ms even with the precomputed maps in place. The
 * AI still replenishes losses (the cap floats with kills) so it doesn't
 * shrivel up after a bad exchange.
 */
const TIER3_UNIT_CAP = 12;

/**
 * Persona-style build hints. Mirrors `BuildPolicy` in `./personas.ts` but kept
 * here as a structural type so the AI module has no upward dependency.
 */
export type BuildPolicyHint = {
  preferred?: ReadonlyArray<UnitType>;
  avoid?: ReadonlyArray<UnitType>;
  infantryFloor?: number;
};

export type UtilityAIOptions = {
  /** Display name (default: "utility"). */
  name?: string;
  /** Weight overrides. Defaults to ai-weights.json. */
  weights?: AIWeights;
  /**
   * If true, precompute a threat map + value map once per turn and use them
   * in `futureThreat` and `positionalValue`. Tier 2 behaviour.
   */
  useThreatMap?: boolean;
  /**
   * If true, assign roles to units at turn start, modulating the per-unit
   * weights and giving `objectiveBonus` something to do. Tier 3 behaviour.
   * Implies `useThreatMap` for the HQ-threat check.
   */
  useRoles?: boolean;
  /**
   * Persona role-multiplier overrides. When provided, these REPLACE the
   * canonical ROLE_MULTIPLIERS map per role for this AI instance. Only
   * meaningful when `useRoles` is on.
   */
  roleMultipliers?: Record<Role, RoleMultipliers>;
  /** Persona BUILD hints. Default: behave as before. */
  buildPolicy?: BuildPolicyHint;
  /**
   * When true, plan under fog-of-war: filter enemy reads through the
   * player's visibility set and add a phantom-threat baseline to hidden
   * tiles so the AI is appropriately cautious about pushing into unknowns.
   */
  fog?: boolean;
};

/**
 * Phantom-threat per hidden tile, in the same units as
 * `threatMap[y][x]` (max HP damage to a representative target). Applied on
 * tiles the AI can't currently see when `fog` is on.
 *
 * Sized so the per-tile penalty is small enough that the AI still pushes
 * forward — at 2, a tank stepping into fog incurs `2 × (7000/1000) × 0.5 ×
 * 0.5 ≈ 3.5` score, below the +1.8 objective bonus and the positional gains
 * from approaching the enemy HQ. The AI still preferentially scouts (recon
 * with vision-5 reveals more tiles per step), but it doesn't paralyse.
 */
const PHANTOM_THREAT_PER_HIDDEN_TILE = 2;

export const utilityAI: AIFactory = (opts) => {
  const name = (opts?.name as string | undefined) ?? 'utility';
  const weights = (opts?.weights as AIWeights | undefined) ?? DEFAULT_AI_WEIGHTS;
  const useThreatMap = (opts?.useThreatMap as boolean | undefined) ?? false;
  const useRoles = (opts?.useRoles as boolean | undefined) ?? false;
  const roleMultipliers =
    (opts?.roleMultipliers as Record<Role, RoleMultipliers> | undefined) ?? ROLE_MULTIPLIERS;
  const buildPolicy = (opts?.buildPolicy as BuildPolicyHint | undefined) ?? {};
  const fog = (opts?.fog as boolean | undefined) ?? false;
  // `useRoles` implies `useThreatMap` — we need an HQ threat read for the
  // defender promotion.
  const effectiveThreatMap = useThreatMap || useRoles;
  return {
    name,
    takeTurn(ctx: AIContext): Action[] {
      return planUtilityTurn(ctx, weights, {
        useThreatMap: effectiveThreatMap,
        useRoles,
        roleMultipliers,
        buildPolicy,
        fog,
      });
    },
  };
};

type PlanOptions = {
  useThreatMap: boolean;
  useRoles: boolean;
  roleMultipliers: Record<Role, RoleMultipliers>;
  buildPolicy: BuildPolicyHint;
  fog: boolean;
};

function planUtilityTurn(
  ctx: AIContext,
  weights: AIWeights,
  planOpts: PlanOptions,
): Action[] {
  const { player } = ctx;
  // Fog-of-war: replace truth with the player's filtered view BEFORE any
  // planning logic runs. Every downstream `state.units` read then auto-filters,
  // and the AI's internal `reduce(...)` simulations evolve from the visible
  // roster — i.e. the AI plans against what it can see, just like a human.
  let state = planOpts.fog ? viewStateForPlayer(ctx.state, player) : ctx.state;
  // Pre-compute the truth-state hidden-tiles set ONCE per turn — phantom-threat
  // augmentation needs the real visibility (not the filtered state's, which is
  // identical anyway but cheaper to derive from the raw state).
  const hidden = planOpts.fog ? hiddenTiles(ctx.state, player) : null;
  const out: Action[] = [];

  log('ai', 'utility turn start', { player, turn: state.turn, fog: planOpts.fog });

  if (state.currentPlayer !== player) {
    out.push({ type: 'END_TURN' });
    return out;
  }

  // ─── Per-turn precomputation ──────────────────────────────────────────────
  // Enemy move-range cache: maps enemy unit id -> Set<coordKey> of tiles they
  // could reach next turn. Computed lazily; reset whenever we mutate state
  // (since an enemy could have died).
  //
  // The threat map, value map, and role assignments are computed ONCE at the
  // beginning of the turn and stay valid for the whole turn. Enemy positions
  // and roster don't change during our turn (we move our units; theirs are
  // static). The only mid-turn deltas are:
  //   - an enemy DIES from our attack (their threat contribution to the map
  //     becomes stale-positive — an over-estimate that's safe to keep);
  //   - our roster changes from BUILD (handled separately at end of turn).
  // Stale-positive threats just make our AI slightly more cautious for the
  // remaining actions, which is a fine trade for keeping the per-turn budget
  // under 200ms on crossroads.
  let enemyReachCache: Map<string, Set<string>> | null = null;
  let threatMapCache: ThreatMap | null = null;
  let valueMapCache: ValueMap | null = null;
  let roleCache: Map<UnitId, Role> | null = null;
  let frontlineTargetCache: Coord | null = null;
  const invalidateEnemyReach = (): void => {
    enemyReachCache = null;
  };
  const getEnemyReach = (s: GameState): Map<string, Set<string>> => {
    if (enemyReachCache) return enemyReachCache;
    enemyReachCache = computeEnemyReachRanges(s, player);
    return enemyReachCache;
  };
  const getThreatMap = (s: GameState): ThreatMap => {
    if (threatMapCache) return threatMapCache;
    const raw = computeThreatMap(s, otherPlayer(player), player);
    // Under fog, augment with a phantom-threat baseline on hidden tiles so
    // the AI doesn't blithely sprint into the dark. Mutating in place is safe
    // here — the map was freshly allocated by computeThreatMap.
    if (hidden) {
      for (let y = 0; y < raw.length; y++) {
        const row = raw[y]!;
        for (let x = 0; x < row.length; x++) {
          if (!hidden.has(`${x},${y}`)) continue;
          if (row[x]! < PHANTOM_THREAT_PER_HIDDEN_TILE) {
            row[x] = PHANTOM_THREAT_PER_HIDDEN_TILE;
          }
        }
      }
    }
    threatMapCache = raw;
    return threatMapCache;
  };
  const getValueMap = (s: GameState): ValueMap => {
    if (valueMapCache) return valueMapCache;
    valueMapCache = computeValueMap(s, player);
    return valueMapCache;
  };
  const getRoles = (s: GameState): Map<UnitId, Role> => {
    if (roleCache) return roleCache;
    roleCache = assignRoles(s, player, getThreatMap(s));
    if (planOpts.useRoles) {
      log('ai', 'roles assigned', countByRole(roleCache));
    }
    return roleCache;
  };
  const getFrontlineTarget = (s: GameState): Coord | null => {
    if (frontlineTargetCache) return frontlineTargetCache;
    frontlineTargetCache = hottestThreatTile(getThreatMap(s));
    return frontlineTargetCache;
  };

  // Optional one-shot log of the threat map (very noisy — gated by ai-trace).
  if (planOpts.useThreatMap && isLogEnabled('ai-trace')) {
    log('ai-trace', 'threat map', getThreatMap(state));
  }

  let stepCount = 0;
  let progress = true;
  while (progress && stepCount < ACTION_STEP_CAP - 1) {
    progress = false;
    // Order: cost desc, id asc as tiebreak (stable for determinism).
    const ordered = orderedOwnedUnits(state, player);
    for (const unitId of ordered) {
      if (stepCount >= ACTION_STEP_CAP - 1) break;
      const unit = state.units[unitId];
      if (!unit) continue;
      if (unit.hasMoved && unit.hasActed) continue;

      const enemyReach = getEnemyReach(state);
      const tm = planOpts.useThreatMap ? getThreatMap(state) : null;
      const role = planOpts.useRoles ? getRoles(state).get(unit.id) ?? null : null;
      // Pre-multiply role multipliers into the unit's effective weights ONCE
      // per unit per turn so scoreAction doesn't allocate a fresh object per
      // candidate. Persona overrides (if any) replace the canonical table.
      const effectiveWeights = role
        ? applyRoleMultipliers(weights, planOpts.roleMultipliers[role])
        : weights;
      const ctx2: ScoreContext = {
        weights: effectiveWeights,
        planOpts,
        enemyReach,
        threatMap: tm,
        valueMap: planOpts.useThreatMap ? getValueMap(state) : null,
        role,
        frontlineTarget: tm ? getFrontlineTarget(state) : null,
      };
      const pick = pickBestCandidate(state, unit, ctx2);
      if (!pick) continue;
      if (pick.score <= 0) continue;

      if (pick.candidate.moveAction) {
        out.push(pick.candidate.moveAction);
        state = reduce(state, pick.candidate.moveAction);
        stepCount += 1;
      }
      out.push(pick.candidate.followUp);
      state = reduce(state, pick.candidate.followUp);
      stepCount += 1;
      // Only the enemy-reach cache becomes stale per action; the threat map,
      // value map, roles, and frontline target are stable per turn (see
      // comment at the top of planUtilityTurn).
      invalidateEnemyReach();
      progress = true;
      if (state.winner !== null) break;
    }
    if (state.winner !== null) break;
  }

  // Build phase: greedy spend on the most expensive affordable unit per
  // factory. Cheap heuristic that prevents the AI from sitting on cash.
  //
  // For Tier 2/3 we add a soft cap on owned-unit count: building infinite
  // units snowballs to 60+ on large maps, which puts the per-turn AI budget
  // way over 200ms. Capping at TIER3_UNIT_CAP keeps action volume per turn
  // bounded while still letting the AI replenish losses.
  if (state.winner === null) {
    const unitCap = planOpts.useRoles ? TIER3_UNIT_CAP : Infinity;
    let myUnits = countOwnedAll(state, player);
    for (const b of enumerateBuilds(state, player, planOpts.buildPolicy)) {
      if (stepCount >= ACTION_STEP_CAP - 1) break;
      if (myUnits >= unitCap) break;
      if (!isLegalAction(state, b).legal) continue;
      const next = reduce(state, b);
      if (next === state) continue;
      out.push(b);
      state = next;
      stepCount += 1;
      myUnits += 1;
    }
  }

  out.push({ type: 'END_TURN' });
  log('ai', 'utility turn end', { player, steps: out.length });
  return out;
}

// ─────────────────────────── Candidate scoring ───────────────────────────────

type Scored = { candidate: Candidate; score: number };

/**
 * Bundled per-turn scoring context. Lives across a single AI turn and is
 * threaded into `scoreAction` so the heuristic terms have O(1) access to the
 * caches.
 */
export type ScoreContext = {
  /** Already-effective weights: base × role multipliers (when useRoles). */
  weights: AIWeights;
  planOpts: PlanOptions;
  enemyReach: Map<string, Set<string>>;
  /** Non-null iff `planOpts.useThreatMap`. */
  threatMap: ThreatMap | null;
  /** Non-null iff `planOpts.useThreatMap`. */
  valueMap: ValueMap | null;
  /** Non-null iff `planOpts.useRoles`. */
  role: Role | null;
  /** Tier 3: precomputed objective-target tile for the frontline role
   *  (hottest threatMap tile). Saves a full map scan per candidate. Null when
   *  no useful target exists. */
  frontlineTarget: Coord | null;
};

function pickBestCandidate(
  state: GameState,
  unit: Unit,
  sctx: ScoreContext,
): Scored | null {
  let best: Scored | null = null;
  for (const c of generateCandidates(state, unit)) {
    const score = scoreAction(state, c, unit, sctx);
    if (isLogEnabled('ai-trace')) {
      log('ai-trace', 'candidate', {
        unit: unit.id,
        dest: c.destination,
        followUp: c.followUp.type,
        score: Number(score.toFixed(3)),
        role: sctx.role,
      });
    }
    if (best === null || score > best.score) {
      best = { candidate: c, score };
    }
  }
  return best;
}

/**
 * scoreAction = sum of weighted heuristic components.
 *
 *   damageDealt      × W.damageDealt
 * + captureProgress  × W.capture
 * - counterAttackDmg × W.counterRisk
 * - futureThreat     × W.futureThreat       (threatMap[y][x] when Tier 2)
 * + positionalValue  × W.positional         (+ valueMap[y][x]×w when Tier 2)
 * + objectiveBonus   × W.objective          (real value when Tier 3)
 *
 * When `sctx.role` is set, the per-key weights are scaled by the role
 * multipliers from `ROLE_MULTIPLIERS`.
 *
 * `unit` is the acting unit's PRE-action snapshot (for positional baseline).
 * The post-action unit is read from `candidate.finalState`.
 */
export function scoreAction(
  state: GameState,
  candidate: Candidate,
  unit: Unit,
  sctx: ScoreContext,
): number {
  const after = candidate.finalState;
  const movedUnit = after.units[unit.id];
  // sctx.weights is already role-multiplied (see planUtilityTurn).
  const w = sctx.weights;
  // The unit may have been killed by a counter-attack — treat as a heavy
  // negative so the AI never elects to suicide.
  if (!movedUnit) {
    return (
      damageDealt(state, after, unit.owner) * w.damageDealt -
      (unit.hp * (UNITS[unit.type].cost / 1000)) * w.counterRisk -
      50 // self-death penalty
    );
  }

  // Future-threat term: O(1) lookup when a threat map is available, otherwise
  // fall back to the Phase 4 per-enemy scan.
  const ft = sctx.threatMap
    ? futureThreatFromMap(sctx.threatMap, movedUnit)
    : futureThreat(after, movedUnit, sctx.enemyReach);

  // Positional value: terrain bonus stays; HQ-distance term is replaced by
  // a valueMap lookup when available.
  const pv = sctx.valueMap
    ? positionalValueFromMaps(after, movedUnit, sctx.valueMap)
    : positionalValue(after, movedUnit);

  // Objective bonus depends on role.
  const ob = sctx.role
    ? objectiveBonusForRole(state, unit, movedUnit, sctx.role, sctx.frontlineTarget)
    : objectiveBonus(after, movedUnit);

  return (
    damageDealt(state, after, unit.owner) * w.damageDealt +
    captureProgressScore(state, after, movedUnit, candidate.followUp) * w.capture -
    counterAttackDamage(state, after, unit) * w.counterRisk -
    ft * w.futureThreat +
    pv * w.positional +
    ob * w.objective
  );
}

// ─────────────────────────── Helpers ─────────────────────────────────────────

/**
 * Sum over each ENEMY unit of `(hpBefore - hpAfter) × (cost/1000)`. A
 * destroyed enemy contributes its full pre-action HP × cost/1000. We compute
 * this from `state.owner`'s perspective: only enemies (relative to `viewer`)
 * count.
 */
export function damageDealt(
  before: GameState,
  after: GameState,
  viewer: PlayerId,
): number {
  let total = 0;
  for (const b of Object.values(before.units)) {
    if (b.owner === viewer) continue;
    const a = after.units[b.id];
    const hpAfter = a ? a.hp : 0;
    const delta = b.hp - hpAfter;
    if (delta <= 0) continue;
    const cost = UNITS[b.type].cost;
    total += delta * (cost / 1000);
  }
  return total;
}

/**
 * +5 if CAPTURE flipped the tile, +2 if it accumulated progress without
 * flipping, 0 otherwise.
 *
 * We detect flips by comparing tile owner before/after; we detect partial
 * progress by checking the post-action unit's captureProgress > 0.
 */
export function captureProgressScore(
  _before: GameState,
  after: GameState,
  movedUnit: Unit,
  followUp: Action,
): number {
  if (followUp.type !== 'CAPTURE') return 0;
  // Owner-flip detection: if the tile is now owned by the unit, it flipped.
  // The CAPTURE only ran if the tile was unowned-by-us beforehand (the engine
  // would have rejected otherwise) so the post-action owner === unit.owner is
  // sufficient to detect the flip.
  const afterTile = tileAt(after.map, movedUnit.pos);
  if (afterTile.owner === movedUnit.owner) return 5;
  if (movedUnit.captureProgress > 0) return 2;
  return 0;
}

/**
 * Predicted counter-damage in HP from the exchange, weighted by the
 * attacking enemy's cost/1000. We read it from the difference in our
 * acting unit's HP before vs after. If our unit died, we charge its full HP.
 */
export function counterAttackDamage(
  _before: GameState,
  after: GameState,
  unit: Unit,
): number {
  const a = after.units[unit.id];
  const hpAfter = a ? a.hp : 0;
  const delta = unit.hp - hpAfter;
  if (delta <= 0) return 0;
  const cost = UNITS[unit.type].cost;
  return delta * (cost / 1000);
}

/**
 * For each enemy unit, max damage they could deal to `unit` at its new
 * position next turn (assuming worst-case enemy movement — ignoring friendly
 * blockers, but obeying terrain impassability and map bounds), weighted by
 * that enemy's `cost / 1000`. Summed across all enemies, then × 0.5
 * (uncertainty discount).
 *
 * `enemyReach` maps enemy id -> set of `coordKey` they could occupy next
 * turn. Pre-computed once per AI turn and shared across candidate scoring.
 */
export function futureThreat(
  state: GameState,
  unit: Unit,
  enemyReach: Map<string, Set<string>>,
): number {
  let total = 0;
  for (const enemy of Object.values(state.units)) {
    if (enemy.owner === unit.owner) continue;
    const reach = enemyReach.get(enemy.id);
    if (!reach) continue;
    // Can the enemy reach a tile that can attack our new position?
    const max = maxDamageFromAnyReachableTile(state, enemy, unit, reach);
    if (max <= 0) continue;
    const cost = UNITS[enemy.type].cost;
    total += max * (cost / 1000);
  }
  return total * 0.5;
}

/**
 * Max damage `enemy` could deal to `target` from any tile in `reach` (a set
 * of coordKey "x,y"). For direct units the enemy must end adjacent to the
 * target; for indirect units, within `[minRange, maxRange]`. We use the
 * computed damage formula at the candidate position — same primitive as the
 * combat system, so the heuristic stays consistent with reality.
 */
function maxDamageFromAnyReachableTile(
  state: GameState,
  enemy: Unit,
  target: Unit,
  reach: Set<string>,
): number {
  const stats = UNITS[enemy.type];
  let best = 0;
  // Iterate the smaller set: tiles in attack range of target ∩ enemy reach.
  // For direct (range 1) units that's <= 4 tiles. For artillery <= ~16.
  for (let dy = -stats.maxRange; dy <= stats.maxRange; dy++) {
    for (let dx = -stats.maxRange; dx <= stats.maxRange; dx++) {
      const d = Math.abs(dx) + Math.abs(dy);
      if (d < stats.minRange || d > stats.maxRange) continue;
      const cand = { x: target.pos.x + dx, y: target.pos.y + dy };
      if (!inBounds(state.map, cand)) continue;
      const key = `${cand.x},${cand.y}`;
      if (!reach.has(key)) continue;
      // Hypothetical enemy at this tile, attacking target at its current tile.
      // The combat formula reads only target's tile defense — so attacker tile
      // doesn't change the result — but constructing the Unit keeps the API
      // honest for any future per-attacker terrain effects.
      const hypothetical: Unit = { ...enemy, pos: cand };
      const dmg = computeDamage(state, hypothetical, target);
      if (dmg > best) best = dmg;
    }
  }
  return best;
}

/**
 * `-manhattan(unit.pos, enemyHq) × 0.1 + tile.defenseStars × 0.5`.
 *
 * Encourages units to push toward the enemy HQ and stand on defensible
 * terrain. The constants are wired into the formula directly (the AI_WEIGHTS
 * coefficients scale the whole result, not the sub-terms).
 */
export function positionalValue(state: GameState, unit: Unit): number {
  const enemy = otherPlayer(unit.owner);
  const enemyHq = state.players[enemy].hq;
  const dist = manhattan(unit.pos, enemyHq);
  const tile = tileAt(state.map, unit.pos);
  const stars = TERRAIN[tile.terrain].defenseStars;
  return -dist * 0.1 + stars * 0.5;
}

/**
 * Tier 2 positional value: terrain defenseStars (unchanged) + a valueMap
 * lookup scaled by `VALUE_MAP_WEIGHT`. The HQ-distance penalty from the Phase
 * 4 formula is subsumed by the value map's HQ-attraction ramp.
 */
export function positionalValueFromMaps(
  state: GameState,
  unit: Unit,
  valueMap: ValueMap,
): number {
  const tile = tileAt(state.map, unit.pos);
  const stars = TERRAIN[tile.terrain].defenseStars;
  const v = valueMap[unit.pos.y]?.[unit.pos.x] ?? 0;
  return stars * 0.5 + v * VALUE_MAP_WEIGHT;
}

/**
 * Tier 2 future-threat: O(1) lookup. The threat map's per-tile value already
 * encodes "max damage to a representative target standing here next turn",
 * which is exactly what futureThreat sums over enemies — minus the
 * uncertainty discount and the per-enemy cost weighting. We apply a 0.5
 * uncertainty discount and an HP scaling so the magnitude lives in the same
 * ballpark as the Phase 4 term (which is what the weights were tuned against).
 */
export function futureThreatFromMap(
  threatMap: ThreatMap,
  unit: Unit,
): number {
  const raw = threatMap[unit.pos.y]?.[unit.pos.x] ?? 0;
  if (raw <= 0) return 0;
  // Scale by the unit's cost/1000 so losing a tank threatens the score harder
  // than losing an infantry — matches the Phase 4 weighting.
  const cost = UNITS[unit.type].cost;
  return raw * (cost / 1000) * 0.5;
}

/** Phase 4 stub. Tier 3 callers route through `objectiveBonusForRole` instead. */
export function objectiveBonus(_state: GameState, _unit: Unit): number {
  return 0;
}

/**
 * Tier 3 objective bonus. PLAN.md gives the four-line spec; we mirror it:
 *   capturer  : +OBJECTIVE_BONUS if action moves toward nearest unowned capturable
 *   defender  : +OBJECTIVE_BONUS if action moves toward own HQ
 *   support   : +OBJECTIVE_BONUS if action moves AWAY from nearest enemy
 *   pusher    : +OBJECTIVE_BONUS if action moves toward the enemy HQ
 *               (objective-target is explicitly the HQ coord, NOT the
 *               hottest-threat tile — that's the role's whole point).
 *   frontline : +OBJECTIVE_BONUS if action moves toward the highest-threat
 *               concentration WE project against the enemy (i.e. the tile in
 *               our threatMap-from-our-perspective with the largest value),
 *               or — if no threat map is available — toward the nearest enemy.
 *
 * `before` is the pre-action state, `after` is post; `unit` is the pre-action
 * snapshot, `movedUnit` is the post-action unit (alive — caller handles dead).
 */
function objectiveBonusForRole(
  before: GameState,
  unit: Unit,
  movedUnit: Unit,
  role: Role,
  frontlineTarget: Coord | null,
): number {
  // No movement, no bonus (the unit's "objective progress" is zero).
  if (coordEq(unit.pos, movedUnit.pos)) return 0;

  switch (role) {
    case 'capturer': {
      const tgt = nearestUnownedCapturable(before, unit.owner, unit.pos);
      if (!tgt) return 0;
      const dBefore = manhattan(unit.pos, tgt);
      const dAfter = manhattan(movedUnit.pos, tgt);
      return dAfter < dBefore ? OBJECTIVE_BONUS : 0;
    }
    case 'defender': {
      const hq = before.players[unit.owner].hq;
      const dBefore = manhattan(unit.pos, hq);
      const dAfter = manhattan(movedUnit.pos, hq);
      return dAfter < dBefore ? OBJECTIVE_BONUS : 0;
    }
    case 'support': {
      const e = nearestEnemy(before, unit.owner, unit.pos);
      if (!e) return 0;
      const dBefore = manhattan(unit.pos, e.pos);
      const dAfter = manhattan(movedUnit.pos, e.pos);
      // Reward retreat: dAfter > dBefore means we got further away.
      return dAfter > dBefore ? OBJECTIVE_BONUS : 0;
    }
    case 'pusher': {
      // Target the enemy HQ directly. The hottest-threat tile is a defensive
      // concept (it's where enemies project most damage — typically right at
      // our own line); pusher needs offensive pull, so we use the literal
      // enemy HQ coord.
      const enemyHq = before.players[otherPlayer(unit.owner)].hq;
      const dBefore = manhattan(unit.pos, enemyHq);
      const dAfter = manhattan(movedUnit.pos, enemyHq);
      return dAfter < dBefore ? OBJECTIVE_BONUS : 0;
    }
    case 'frontline': {
      // Toward enemy threat concentration if we have a (our) threat map; else
      // toward nearest enemy.
      const target =
        frontlineTarget ?? nearestEnemy(before, unit.owner, unit.pos)?.pos ?? null;
      if (!target) return 0;
      const dBefore = manhattan(unit.pos, target);
      const dAfter = manhattan(movedUnit.pos, target);
      return dAfter < dBefore ? OBJECTIVE_BONUS : 0;
    }
  }
  return 0;
}

function nearestUnownedCapturable(
  state: GameState,
  player: PlayerId,
  from: Coord,
): Coord | null {
  let bestD = Infinity;
  let best: Coord | null = null;
  for (let y = 0; y < state.map.length; y++) {
    const row = state.map[y]!;
    for (let x = 0; x < row.length; x++) {
      const t = row[x]!;
      if (!isCapturable(t.terrain)) continue;
      if (t.owner === player) continue;
      const d = Math.abs(from.x - x) + Math.abs(from.y - y);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best;
}

function nearestEnemy(
  state: GameState,
  player: PlayerId,
  from: Coord,
): Unit | null {
  let bestD = Infinity;
  let best: Unit | null = null;
  for (const u of Object.values(state.units)) {
    if (u.owner === player) continue;
    const d = Math.abs(from.x - u.pos.x) + Math.abs(from.y - u.pos.y);
    if (d < bestD) {
      bestD = d;
      best = u;
    }
  }
  return best;
}

/** Coord with the maximum threat value. Ties broken by lowest (y,x). */
function hottestThreatTile(threatMap: ThreatMap): Coord | null {
  let best: Coord | null = null;
  let bestV = -1;
  for (let y = 0; y < threatMap.length; y++) {
    const row = threatMap[y]!;
    for (let x = 0; x < row.length; x++) {
      const v = row[x]!;
      if (v > bestV) {
        bestV = v;
        best = { x, y };
      }
    }
  }
  return bestV > 0 ? best : null;
}

// ─────────────────────────── Enemy reach precompute ──────────────────────────

/**
 * For each enemy unit, the set of tiles it could occupy next turn,
 * approximated as "any tile within its move budget on a passable-terrain
 * BFS that ignores other units". This is a deliberate over-approximation —
 * the actual enemy may be blocked by its own units or by ours, but the worst
 * case is what we want to penalise.
 */
function computeEnemyReachRanges(
  state: GameState,
  player: PlayerId,
): Map<string, Set<string>> {
  const enemy = otherPlayer(player);
  const out = new Map<string, Set<string>>();
  for (const u of Object.values(state.units)) {
    if (u.owner !== enemy) continue;
    if (u.loadedIn !== undefined) continue; // cargo can't threaten; same gate
    // also masks fog-hidden enemies stamped by viewStateForPlayer.
    out.set(u.id, bfsReachIgnoringUnits(state, u));
  }
  return out;
}

const NEIGHBOURS: ReadonlyArray<Coord> = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

function bfsReachIgnoringUnits(state: GameState, unit: Unit): Set<string> {
  const budget = UNITS[unit.type].move;
  const cls = UNITS[unit.type].movementClass;
  const dist = new Map<string, number>();
  const start = unit.pos;
  const startKey = `${start.x},${start.y}`;
  dist.set(startKey, 0);
  // Min-cost frontier; n is small, linear scan is fine.
  const frontier = new Set<string>([startKey]);
  while (frontier.size > 0) {
    let bestKey: string | null = null;
    let bestCost = Infinity;
    for (const k of frontier) {
      const d = dist.get(k);
      if (d !== undefined && d < bestCost) {
        bestCost = d;
        bestKey = k;
      }
    }
    if (bestKey === null) break;
    frontier.delete(bestKey);
    const [bxs, bys] = bestKey.split(',');
    const here = { x: Number(bxs), y: Number(bys) };
    for (const n of NEIGHBOURS) {
      const cand = { x: here.x + n.x, y: here.y + n.y };
      if (!inBounds(state.map, cand)) continue;
      const tile = tileAt(state.map, cand);
      const cost = TERRAIN[tile.terrain].moveCost[cls];
      if (!isFinite(cost)) continue;
      const total = bestCost + cost;
      if (total > budget) continue;
      const k = `${cand.x},${cand.y}`;
      const ex = dist.get(k);
      if (ex === undefined || total < ex) {
        dist.set(k, total);
        frontier.add(k);
      }
    }
  }
  return new Set(dist.keys());
}

// ─────────────────────────── Unit ordering + build phase ─────────────────────

function orderedOwnedUnits(state: GameState, player: PlayerId): string[] {
  const mine: Unit[] = [];
  for (const u of Object.values(state.units)) {
    if (u.owner !== player) continue;
    // Loaded cargo can't act this turn — skip. Transports themselves may
    // still WAIT but the utility AI ignores them (scope-cut; QUESTIONS.md).
    if (u.loadedIn !== undefined) continue;
    mine.push(u);
  }
  mine.sort((a, b) => {
    const costA = UNITS[a.type].cost;
    const costB = UNITS[b.type].cost;
    if (costA !== costB) return costB - costA;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return mine.map((u) => u.id);
}

/**
 * Build greedily, respecting an optional `BuildPolicyHint`:
 *
 *   - If `infantryFloor` is set and our own infantry count is below it AND
 *     there are unowned capturables on the map, build infantry first.
 *   - Else iterate `policy.preferred` (in order) and pick the first
 *     affordable unit not on the `avoid` list. A type is skipped per-factory
 *     when the factory can't build it (sea units need a coastal factory).
 *   - Else pick the most expensive affordable from the default order
 *     [tank, recon, artillery, infantry], skipping `avoid` if anything else
 *     is affordable.
 *   - As a last resort, build a unit on `avoid` if it's the only affordable
 *     option — so we still spend funds rather than stagnate.
 *
 * The legacy behaviour (no policy) is preserved: infantryFloor=2 (when
 * `unowned > 0`), preferred order [tank, recon, artillery, infantry].
 *
 * Roster expansion (round 6): per-factory legality filtering means a persona
 * with `preferred: [cruiser, tank, ...]` correctly falls through to `tank` on
 * inland factories instead of producing a rejected BUILD that wastes the
 * factory's turn. The greedy affordable-first picker already auto-limits
 * spam of expensive air/sea types — once funds dip below the expensive
 * type's cost, the picker falls through to the next preferred entry.
 */
function enumerateBuilds(
  state: GameState,
  player: PlayerId,
  policy: BuildPolicyHint,
): Action[] {
  const out: Action[] = [];
  const myInfantryCount = countOwned(state, player, 'infantry');
  const myTotalUnits = countOwnedAll(state, player);
  const infantryFloor = policy.infantryFloor ?? 2;
  const avoid = new Set<UnitType>(policy.avoid ?? []);
  const preferred: ReadonlyArray<UnitType> =
    policy.preferred ?? ['tank', 'recon', 'artillery', 'infantry'];

  // Floor activation: a persona with `infantryFloor: 5` would naively keep
  // building infantry on every factory until it owns 5 infantry — even when
  // it already has plenty of tanks/recon — meaning `preferred: [tank, ...]`
  // never fires while the floor is active. Cap the floor by ALSO requiring
  // the total owned unit count to be low (`< floor + 2`), so once we have a
  // healthy mixed force the build phase resumes its `preferred` list. The
  // `+2` tolerance lets a persona with floor=3 still spawn its 4th unit as
  // infantry if it only has 3 infantry and 1 tank, but stops once it has 3
  // infantry + 2 tanks.
  const floorActive = myInfantryCount < infantryFloor && myTotalUnits < infantryFloor + 2;

  for (let y = 0; y < state.map.length; y++) {
    const row = state.map[y]!;
    for (let x = 0; x < row.length; x++) {
      const tile = row[x]!;
      if (tile.terrain !== 'factory') continue;
      if (tile.owner !== player) continue;
      if (occupied(state, x, y)) continue;
      const funds = state.players[player].funds;
      const unowned = unownedCapturables(state, player);
      const factoryCoastal = isCoastalFactory(state, x, y);
      let pick: UnitType | null = null;

      // Per-factory affordability + legality check. Sea-class units need a
      // coastal factory (engine rejects otherwise — the AI would burn a build
      // slot on a guaranteed-illegal action). Cheap to check.
      const buildableHere = (t: UnitType): boolean => {
        if (funds < UNITS[t].cost) return false;
        if (UNITS[t].movementClass === 'sea' && !factoryCoastal) return false;
        return true;
      };

      // Infantry floor — keep capture pressure up, but only when our total
      // unit count is also low (see `floorActive` above).
      if (
        floorActive &&
        unowned > 0 &&
        funds >= UNITS.infantry.cost &&
        !avoid.has('infantry')
      ) {
        pick = 'infantry';
      } else {
        // Walk the preferred list; skip avoided types and types this factory
        // can't legally produce.
        for (const t of preferred) {
          if (avoid.has(t)) continue;
          if (!buildableHere(t)) continue;
          pick = t;
          break;
        }
        // Last-resort fallback: try avoided types so we still spend funds.
        if (!pick) {
          for (const t of preferred) {
            if (!buildableHere(t)) continue;
            pick = t;
            break;
          }
        }
      }
      if (!pick) continue;
      out.push({ type: 'BUILD', at: { x, y }, unitType: pick, owner: player });
    }
  }
  return out;
}

/**
 * True iff `(x, y)` is a factory tile adjacent (orthogonal) to a sea tile.
 * Mirrors the `checkBuild` rule in `core/validators.ts`. Pure read.
 */
function isCoastalFactory(state: GameState, x: number, y: number): boolean {
  const adj = [
    { x: x - 1, y },
    { x: x + 1, y },
    { x, y: y - 1 },
    { x, y: y + 1 },
  ];
  for (const n of adj) {
    if (!inBounds(state.map, n)) continue;
    const t = tileAt(state.map, n);
    if (t.terrain === 'sea') return true;
  }
  return false;
}

function countOwned(state: GameState, player: PlayerId, type: UnitType): number {
  let n = 0;
  for (const u of Object.values(state.units)) {
    if (u.owner === player && u.type === type) n += 1;
  }
  return n;
}

function countOwnedAll(state: GameState, player: PlayerId): number {
  let n = 0;
  for (const u of Object.values(state.units)) {
    if (u.owner === player) n += 1;
  }
  return n;
}

function unownedCapturables(state: GameState, player: PlayerId): number {
  let n = 0;
  for (const row of state.map) {
    for (const tile of row) {
      if (isCapturable(tile.terrain) && tile.owner !== player) n += 1;
    }
  }
  return n;
}

function occupied(state: GameState, x: number, y: number): boolean {
  for (const u of Object.values(state.units)) {
    if (u.loadedIn !== undefined) continue;
    if (u.pos.x === x && u.pos.y === y) return true;
  }
  return false;
}

// Expose helper internals for testing.
export const __test = {
  damageDealt,
  captureProgressScore,
  counterAttackDamage,
  futureThreat,
  futureThreatFromMap,
  positionalValue,
  positionalValueFromMaps,
  computeEnemyReachRanges,
  nearestUnownedCapturable,
  nearestEnemy,
  hottestThreatTile,
  isCoastalFactory,
  enumerateBuilds,
  CAPTURE_THRESHOLD,
  coordEq,
  inAttackRange,
  VALUE_MAP_WEIGHT,
  OBJECTIVE_BONUS,
};
