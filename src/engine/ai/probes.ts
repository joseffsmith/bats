// Scripted "probe" opponents.
//
// Self-play between personas can only surface flaws that *differ* between
// personas. A blind spot every persona shares — "nobody punishes a naive
// rush", "nobody can crack a turtle", "nobody closes on a unit that always
// stands outside their reach" — is invisible in a round-robin because both
// sides suffer from it equally.
//
// A probe is a deliberately degenerate, hard-coded strategy. It is NOT a good
// AI and is not meant to be tuned; it is a fixed yardstick. Every persona is
// expected to beat every probe comfortably (see `scripts/probe-gate.ts`), and
// a persona that cannot is showing a real hole.
//
// The three probes:
//   probe-rush    — every unit beelines at the nearest capturable tile it
//                   doesn't own; infantry captures on arrival; factories pump
//                   infantry only. Tests: do we punish an undefended sprint?
//   probe-camper  — never leaves a Manhattan-3 bubble around its own HQ,
//                   builds artillery then infantry, shoots anything that walks
//                   into range. Tests: can we crack a static defensive ball?
//   probe-kiter   — walks at the enemy HQ but only ever stands on tiles with
//                   ZERO threat (per `computeThreatMap`), and only attacks
//                   from such tiles. Tests: can we corner an evader?
//
// Contract (identical to `random.ts` / the utility AI):
//   - `takeTurn` returns the FULL action sequence for one turn and ALWAYS
//     terminates with END_TURN.
//   - Actions are gated through `generateCandidates`, which itself validates
//     every pair via `isLegalAction`, so probes emit only legal actions.
//   - Deterministic given `ctx.rng`. The probes draw from the rng for unit
//     ordering and score jitter — without that, every seed would replay the
//     identical match (personas themselves consume no randomness).
//   - The input state is never mutated.

import type {
  Action,
  Coord,
  GameState,
  PlayerId,
  Unit,
  UnitType,
} from '../core/types';
import { isCapturable, manhattan, otherPlayer } from '../core/types';
import { reduce } from '../core/reducer';
import { isLegalAction } from '../core/validators';
import { rngInt } from '../core/rng';
import type { Rng } from '../core/rng';
import { log } from '../core/logger';
import { generateCandidates } from './candidates';
import type { Candidate } from './candidates';
import { computeThreatMap } from './threatMap';
import type { ThreatMap } from './threatMap';
import { ACTION_STEP_CAP } from './random';
import type { AI, AIContext } from './types';

// ─────────────────────────── Spec plumbing ───────────────────────────────────

/** Per-turn precomputation shared by every unit the probe moves this turn. */
type TurnContext = {
  readonly player: PlayerId;
  /** Own HQ coordinate. */
  readonly ownHq: Coord;
  /** Enemy HQ coordinate. */
  readonly enemyHq: Coord;
  /**
   * Damage the ENEMY could deal to a tank standing on each tile next turn,
   * computed once against the turn-start state. `0` ⇒ out of everything's
   * reach.
   */
  readonly threat: ThreatMap;
};

/**
 * A probe is a scoring function over the shared candidate generator plus a
 * fixed build order. `goal` is the tile the unit is walking at; `allow` is an
 * optional hard filter (candidates it rejects are never considered).
 */
type ProbeSpec = {
  readonly name: string;
  goal(unit: Unit, state: GameState, tc: TurnContext): Coord;
  allow?(unit: Unit, cand: Candidate, tc: TurnContext, goal: Coord): boolean;
  score(unit: Unit, cand: Candidate, tc: TurnContext, goal: Coord): number;
  /** Priority list consulted per owned factory; first affordable wins. */
  readonly buildOrder: ReadonlyArray<UnitType>;
};

function threatAt(threat: ThreatMap, c: Coord): number {
  return threat[c.y]?.[c.x] ?? 0;
}

// ─────────────────────────── probe-rush ──────────────────────────────────────

const RUSH: ProbeSpec = {
  name: 'probe-rush',
  goal(unit, state, tc) {
    return nearestCapturable(state, unit.pos, tc.player) ?? tc.enemyHq;
  },
  score(_unit, cand, _tc, goal) {
    let s = -manhattan(cand.destination, goal);
    if (cand.followUp.type === 'CAPTURE') s += 1000;
    // A rusher that walks straight past a unit it could shoot would be daft
    // even by probe standards, but taking ground stays the priority.
    else if (cand.followUp.type === 'ATTACK') s += 50;
    return s;
  },
  buildOrder: ['infantry'],
};

/** Nearest capturable tile (city/factory/HQ) not already owned by `player`. */
function nearestCapturable(
  state: GameState,
  from: Coord,
  player: PlayerId,
): Coord | undefined {
  let best: Coord | undefined;
  let bestD = Infinity;
  for (let y = 0; y < state.map.length; y++) {
    const row = state.map[y]!;
    for (let x = 0; x < row.length; x++) {
      const tile = row[x]!;
      if (!isCapturable(tile.terrain)) continue;
      if (tile.owner === player) continue;
      const d = manhattan(from, { x, y });
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best;
}

// ─────────────────────────── probe-camper ────────────────────────────────────

/** Manhattan radius of the camper's bubble around its own HQ. */
const CAMP_RADIUS = 3;

const CAMPER: ProbeSpec = {
  name: 'probe-camper',
  goal(_unit, _state, tc) {
    return tc.ownHq;
  },
  allow(unit, cand, _tc, goal) {
    // Staying put is always permitted — a unit that started (or was built)
    // outside the bubble must still be able to shoot and wait.
    if (!cand.moveAction) return true;
    const d = manhattan(cand.destination, goal);
    if (d <= CAMP_RADIUS) return true;
    // Outside the bubble the only legal motion is back towards the HQ; the
    // camper never takes a step that increases its distance from home.
    return d < manhattan(unit.pos, goal);
  },
  score(_unit, cand, _tc, goal) {
    let s = -manhattan(cand.destination, goal);
    if (cand.followUp.type === 'ATTACK') s += 1000;
    else if (cand.followUp.type === 'CAPTURE') s += 500;
    return s;
  },
  buildOrder: ['artillery', 'infantry'],
};

// ─────────────────────────── probe-kiter ─────────────────────────────────────

const KITER: ProbeSpec = {
  name: 'probe-kiter',
  goal(_unit, _state, tc) {
    return tc.enemyHq;
  },
  allow(_unit, cand, tc) {
    // Only swing from a tile nothing can counter-reach.
    if (cand.followUp.type !== 'ATTACK') return true;
    return threatAt(tc.threat, cand.destination) === 0;
  },
  score(_unit, cand, tc, goal) {
    // The distance term is bounded by the map diameter (tens), so the threat
    // penalty is lexicographic in practice: a zero-threat tile always beats a
    // threatened one, and only then does closing on the HQ break the tie.
    let s = -manhattan(cand.destination, goal);
    if (threatAt(tc.threat, cand.destination) > 0) s -= 1000;
    if (cand.followUp.type === 'ATTACK') s += 2000;
    else if (cand.followUp.type === 'CAPTURE') s += 300;
    return s;
  },
  buildOrder: ['artillery', 'tank', 'infantry'],
};

// ─────────────────────────── Turn driver ─────────────────────────────────────

function planProbeTurn(spec: ProbeSpec, ctx: AIContext): Action[] {
  const { player, rng } = ctx;
  let state = ctx.state;
  const out: Action[] = [];

  log('ai', 'probe turn start', { probe: spec.name, player, turn: state.turn });

  // Defensive sanity: if it isn't our turn, bail with just END_TURN.
  if (state.currentPlayer !== player) {
    out.push({ type: 'END_TURN' });
    return out;
  }

  const enemy = otherPlayer(player);
  const tc: TurnContext = {
    player,
    ownHq: state.players[player].hq,
    enemyHq: state.players[enemy].hq,
    // Threat *against us*: what the enemy's units could hit next turn. Taken
    // once against the turn-start state — enemy units don't move during our
    // turn, so it stays valid for the whole plan.
    threat: computeThreatMap(state, enemy, player),
  };

  let stepCount = 0;
  for (const unitId of shuffleByIds(ownedUnits(state, player), rng)) {
    if (stepCount >= ACTION_STEP_CAP - 1) break;
    // Re-look-up — earlier actions may have moved or killed units.
    const unit = state.units[unitId];
    if (!unit) continue;
    if (unit.owner !== player) continue;
    if (unit.loadedIn !== undefined) continue;
    if (unit.hasMoved && unit.hasActed) continue;

    const goal = spec.goal(unit, state, tc);
    const pick = bestCandidate(spec, state, unit, tc, goal, rng);
    if (!pick) continue;

    if (pick.moveAction) {
      out.push(pick.moveAction);
      state = reduce(state, pick.moveAction);
      stepCount += 1;
    }
    // WAIT after a MOVE is redundant (the engine accepts END_TURN regardless),
    // but a stay-put candidate needs its follow-up to consume the action.
    if (pick.followUp.type !== 'WAIT' || !pick.moveAction) {
      out.push(pick.followUp);
      state = reduce(state, pick.followUp);
      stepCount += 1;
    }
  }

  // ── BUILD phase ──────────────────────────────────────────────────────────
  for (const at of ownedFactories(state, player)) {
    if (stepCount >= ACTION_STEP_CAP - 1) break;
    for (const unitType of spec.buildOrder) {
      const build: Action = { type: 'BUILD', at, unitType, owner: player };
      if (!isLegalAction(state, build).legal) continue;
      const next = reduce(state, build);
      if (next === state) continue;
      out.push(build);
      state = next;
      stepCount += 1;
      break;
    }
  }

  out.push({ type: 'END_TURN' });
  log('ai', 'probe turn end', { probe: spec.name, player, steps: out.length });
  return out;
}

/**
 * Highest-scoring allowed candidate for `unit`. Ties are broken by a tiny rng
 * jitter — the candidate count is a pure function of the state, so the draw
 * sequence (and hence the pick) is reproducible from the seed.
 */
function bestCandidate(
  spec: ProbeSpec,
  state: GameState,
  unit: Unit,
  tc: TurnContext,
  goal: Coord,
  rng: Rng,
): Candidate | undefined {
  let best: Candidate | undefined;
  let bestScore = -Infinity;
  for (const cand of generateCandidates(state, unit)) {
    if (spec.allow && !spec.allow(unit, cand, tc, goal)) continue;
    const s = spec.score(unit, cand, tc, goal) + rng() * 0.001;
    if (s > bestScore) {
      bestScore = s;
      best = cand;
    }
  }
  return best;
}

function ownedUnits(state: GameState, player: PlayerId): Unit[] {
  const out: Unit[] = [];
  for (const u of Object.values(state.units)) {
    if (u.owner !== player) continue;
    if (u.loadedIn !== undefined) continue; // cargo can't act
    out.push(u);
  }
  return out;
}

/** Fisher–Yates shuffle of unit ids, seeded from `rng` (sorted first). */
function shuffleByIds(units: ReadonlyArray<Unit>, rng: Rng): string[] {
  const ids = units.map((u) => u.id).sort();
  for (let i = ids.length - 1; i > 0; i--) {
    const j = rngInt(rng, i + 1);
    const tmp = ids[i]!;
    ids[i] = ids[j]!;
    ids[j] = tmp;
  }
  return ids;
}

/** Owned factory tiles in row-major order. Legality is left to the validator. */
function ownedFactories(state: GameState, player: PlayerId): Coord[] {
  const out: Coord[] = [];
  for (let y = 0; y < state.map.length; y++) {
    const row = state.map[y]!;
    for (let x = 0; x < row.length; x++) {
      const tile = row[x]!;
      if (tile.terrain !== 'factory') continue;
      if (tile.owner !== player) continue;
      out.push({ x, y });
    }
  }
  return out;
}

// ─────────────────────────── Registry ────────────────────────────────────────

const PROBE_SPECS: ReadonlyArray<ProbeSpec> = [CAMPER, KITER, RUSH];

/** name → spec. */
const PROBES: Record<string, ProbeSpec> = Object.fromEntries(
  PROBE_SPECS.map((s) => [s.name, s]),
);

/** Sorted probe names — stable order for CLI defaults and tests. */
export const PROBE_NAMES: ReadonlyArray<string> = Object.keys(PROBES).sort();

export function isProbeName(s: string): boolean {
  return s in PROBES;
}

/**
 * Build the named probe AI. `opts` is accepted for signature parity with
 * `personaAI` — probes ignore fog entirely (they plan against engine truth,
 * which is fine: they're yardsticks, not contenders).
 */
export function probeAI(name: string): AI {
  const spec = PROBES[name];
  if (!spec) {
    throw new Error(
      `unknown probe "${name}" — available: ${PROBE_NAMES.join(', ')}`,
    );
  }
  return {
    name: spec.name,
    takeTurn(ctx: AIContext): Action[] {
      return planProbeTurn(spec, ctx);
    },
  };
}

// Exported for tests / debugging.
export const __test = { nearestCapturable, CAMP_RADIUS };
