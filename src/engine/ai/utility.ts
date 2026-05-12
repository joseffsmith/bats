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

// Soft cap on actions per turn so a bug can't infinite-loop the runner.
const ACTION_STEP_CAP = 200;

/** Re-export for callers that want the default. */
export const DEFAULT_AI_WEIGHTS: AIWeights = AI_WEIGHTS;

export const utilityAI: AIFactory = (opts) => {
  const name = (opts?.name as string | undefined) ?? 'utility';
  const weights = (opts?.weights as AIWeights | undefined) ?? DEFAULT_AI_WEIGHTS;
  return {
    name,
    takeTurn(ctx: AIContext): Action[] {
      return planUtilityTurn(ctx, weights);
    },
  };
};

function planUtilityTurn(ctx: AIContext, weights: AIWeights): Action[] {
  const { player } = ctx;
  let state = ctx.state;
  const out: Action[] = [];

  log('ai', 'utility turn start', { player, turn: state.turn });

  if (state.currentPlayer !== player) {
    out.push({ type: 'END_TURN' });
    return out;
  }

  // Enemy move-range cache: maps enemy unit id -> Set<coordKey> of tiles they
  // could reach next turn. Computed lazily; reset whenever we mutate state
  // (since an enemy could have died).
  let enemyReachCache: Map<string, Set<string>> | null = null;
  const invalidateCache = (): void => {
    enemyReachCache = null;
  };
  const getEnemyReach = (s: GameState): Map<string, Set<string>> => {
    if (enemyReachCache) return enemyReachCache;
    enemyReachCache = computeEnemyReachRanges(s, player);
    return enemyReachCache;
  };

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
      const pick = pickBestCandidate(state, unit, weights, enemyReach);
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
      invalidateCache();
      progress = true;
      if (state.winner !== null) break;
    }
    if (state.winner !== null) break;
  }

  // Build phase: greedy spend on the most expensive affordable unit per
  // factory. Cheap heuristic that prevents the AI from sitting on cash.
  if (state.winner === null) {
    for (const b of enumerateBuilds(state, player)) {
      if (stepCount >= ACTION_STEP_CAP - 1) break;
      if (!isLegalAction(state, b).legal) continue;
      const next = reduce(state, b);
      if (next === state) continue;
      out.push(b);
      state = next;
      stepCount += 1;
    }
  }

  out.push({ type: 'END_TURN' });
  log('ai', 'utility turn end', { player, steps: out.length });
  return out;
}

// ─────────────────────────── Candidate scoring ───────────────────────────────

type Scored = { candidate: Candidate; score: number };

function pickBestCandidate(
  state: GameState,
  unit: Unit,
  weights: AIWeights,
  enemyReach: Map<string, Set<string>>,
): Scored | null {
  let best: Scored | null = null;
  for (const c of generateCandidates(state, unit)) {
    const score = scoreAction(state, c, unit, weights, enemyReach);
    if (isLogEnabled('ai-trace')) {
      log('ai-trace', 'candidate', {
        unit: unit.id,
        dest: c.destination,
        followUp: c.followUp.type,
        score: Number(score.toFixed(3)),
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
 * - futureThreat     × W.futureThreat
 * + positionalValue  × W.positional
 * + objectiveBonus   × W.objective
 *
 * `unit` is the acting unit's PRE-action snapshot (for positional baseline).
 * The post-action unit is read from `candidate.finalState`.
 */
export function scoreAction(
  state: GameState,
  candidate: Candidate,
  unit: Unit,
  weights: AIWeights,
  enemyReach: Map<string, Set<string>>,
): number {
  const after = candidate.finalState;
  const movedUnit = after.units[unit.id];
  // The unit may have been killed by a counter-attack — treat as a heavy
  // negative so the AI never elects to suicide.
  if (!movedUnit) {
    return (
      damageDealt(state, after, unit.owner) * weights.damageDealt -
      (unit.hp * (UNITS[unit.type].cost / 1000)) * weights.counterRisk -
      50 // self-death penalty
    );
  }

  return (
    damageDealt(state, after, unit.owner) * weights.damageDealt +
    captureProgressScore(state, after, movedUnit, candidate.followUp) * weights.capture -
    counterAttackDamage(state, after, unit) * weights.counterRisk -
    futureThreat(after, movedUnit, enemyReach) * weights.futureThreat +
    positionalValue(after, movedUnit) * weights.positional +
    objectiveBonus(after, movedUnit) * weights.objective
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

/** Phase 5 will populate this with role-based objectives. */
export function objectiveBonus(_state: GameState, _unit: Unit): number {
  return 0;
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
    if (u.owner === player) mine.push(u);
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
 * Build greedily: pick the most expensive affordable unit on each owned
 * factory. Prefer infantry early if we own no infantry on a frontier near a
 * capturable tile (very simple heuristic to keep capture pressure up).
 */
function enumerateBuilds(state: GameState, player: PlayerId): Action[] {
  const out: Action[] = [];
  const myInfantryCount = countOwned(state, player, 'infantry');
  for (let y = 0; y < state.map.length; y++) {
    const row = state.map[y]!;
    for (let x = 0; x < row.length; x++) {
      const tile = row[x]!;
      if (tile.terrain !== 'factory') continue;
      if (tile.owner !== player) continue;
      if (occupied(state, x, y)) continue;
      const funds = state.players[player].funds;
      // Choose by priority: if we have very few infantry and there are
      // unowned capturables on the map, prefer infantry. Otherwise pick the
      // most expensive affordable.
      const unowned = unownedCapturables(state, player);
      let pick: UnitType | null = null;
      if (myInfantryCount < 2 && unowned > 0 && funds >= UNITS.infantry.cost) {
        pick = 'infantry';
      } else {
        // Most expensive affordable from the offensive set.
        const order: UnitType[] = ['tank', 'recon', 'artillery', 'infantry'];
        for (const t of order) {
          if (funds >= UNITS[t].cost) {
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

function countOwned(state: GameState, player: PlayerId, type: UnitType): number {
  let n = 0;
  for (const u of Object.values(state.units)) {
    if (u.owner === player && u.type === type) n += 1;
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
  positionalValue,
  computeEnemyReachRanges,
  CAPTURE_THRESHOLD,
  coordEq,
  inAttackRange,
};
