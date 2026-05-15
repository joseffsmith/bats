// Random AI.
//
// For each owned unit, picks uniformly among the legal action candidates the
// shared `generateCandidates` generator yields. Used both for engine sanity
// testing and as the Phase 4 punching bag for the utility AI.
//
// Termination contract: ALWAYS ends the returned `Action[]` with `END_TURN`.
// We hard-cap the per-turn action count at `ACTION_STEP_CAP` so a pathological
// state can't keep us looping forever; if we hit the cap we still emit
// END_TURN so the runner advances.

import type { Action, GameState, Unit } from '../core/types';
import { reduce } from '../core/reducer';
import { isLegalAction } from '../core/validators';
import { UNITS, INCOME_TERRAIN } from '../data';
import { rngInt, rngPick } from '../core/rng';
import type { Rng } from '../core/rng';
import { log } from '../core/logger';
import { generateCandidates } from './candidates';
import type { AIContext, AIFactory } from './types';

/** Absolute upper bound on actions a single AI turn may emit (including END_TURN). */
export const ACTION_STEP_CAP = 200;

export const randomAI: AIFactory = (opts) => ({
  name: (opts?.name as string | undefined) ?? 'random',
  takeTurn(ctx: AIContext): Action[] {
    return planRandomTurn(ctx);
  },
});

function planRandomTurn(ctx: AIContext): Action[] {
  const { player, rng } = ctx;
  let state = ctx.state;
  const out: Action[] = [];

  log('ai', 'random turn start', { player, turn: state.turn });

  // Defensive sanity: if it isn't our turn, bail with just END_TURN.
  if (state.currentPlayer !== player) {
    out.push({ type: 'END_TURN' });
    return out;
  }

  // Iterate over the player's units in stable-shuffled order. The order is
  // randomised so successive turns don't ossify into the same pattern.
  // Shuffle by id (deterministic for a given rng) so a re-run with the same
  // seed reproduces the same plan.
  const myUnits = ownedUnits(state, player);
  const order = shuffleByIds(myUnits, rng);

  let stepCount = 0;
  for (const unitId of order) {
    if (stepCount >= ACTION_STEP_CAP - 1) break;
    // Re-look-up — earlier actions may have moved/killed units.
    const unit = state.units[unitId];
    if (!unit) continue;
    if (unit.owner !== player) continue;
    if (unit.hasMoved && unit.hasActed) continue;

    const cands = collectCandidates(state, unit);
    if (cands.length === 0) continue;
    const pick = rngPick(rng, cands);

    if (pick.moveAction) {
      out.push(pick.moveAction);
      state = reduce(state, pick.moveAction);
      stepCount += 1;
    }
    if (pick.followUp.type !== 'WAIT' || !pick.moveAction) {
      // Always commit the follow-up. WAIT after MOVE is redundant (MOVE marks
      // hasMoved but not hasActed; the engine accepts END_TURN regardless), but
      // we include WAIT for stay-put candidates so the unit actually consumes
      // its action.
      out.push(pick.followUp);
      state = reduce(state, pick.followUp);
      stepCount += 1;
    }
  }

  // Random BUILD: with a coin flip per affordable factory, buy something we
  // can afford. Keeps the random AI from sitting on cash forever (which would
  // make matches unwinnable).
  const builds = enumerateBuilds(state, player);
  for (const b of builds) {
    if (stepCount >= ACTION_STEP_CAP - 1) break;
    if (rng() < 0.5) continue;
    if (!isLegalAction(state, b).legal) continue;
    const next = reduce(state, b);
    if (next === state) continue;
    out.push(b);
    state = next;
    stepCount += 1;
  }

  out.push({ type: 'END_TURN' });
  log('ai', 'random turn end', { player, steps: out.length });
  return out;
}

function collectCandidates(state: GameState, unit: Unit): Array<{
  moveAction?: Action;
  followUp: Action;
}> {
  const out: Array<{ moveAction?: Action; followUp: Action }> = [];
  for (const c of generateCandidates(state, unit)) {
    const item: { moveAction?: Action; followUp: Action } = {
      followUp: c.followUp,
    };
    if (c.moveAction) item.moveAction = c.moveAction;
    out.push(item);
  }
  return out;
}

function ownedUnits(state: GameState, player: number): Unit[] {
  const out: Unit[] = [];
  for (const u of Object.values(state.units)) {
    if (u.owner !== player) continue;
    if (u.loadedIn !== undefined) continue; // cargo can't act
    out.push(u);
  }
  return out;
}

/** Fisher–Yates shuffle of unit ids. Stable order via initial sort by id. */
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

/**
 * Every legal BUILD action available on owned factories (cheapest tier we'd
 * ever consider — infantry, recon, tank). We deliberately exclude artillery
 * and copter from random's build list because the random AI cannot operate
 * them effectively and including them just dumps cash.
 */
function enumerateBuilds(state: GameState, player: number): Action[] {
  const out: Action[] = [];
  for (let y = 0; y < state.map.length; y++) {
    const row = state.map[y]!;
    for (let x = 0; x < row.length; x++) {
      const tile = row[x]!;
      if (tile.terrain !== 'factory') continue;
      if (tile.owner !== player) continue;
      if (occupied(state, x, y)) continue;
      const funds = state.players[player as 0 | 1].funds;
      const choices: Array<'infantry' | 'recon' | 'tank'> = [];
      if (funds >= UNITS.tank.cost) choices.push('tank');
      else if (funds >= UNITS.recon.cost) choices.push('recon');
      if (funds >= UNITS.infantry.cost) choices.push('infantry');
      if (choices.length === 0) continue;
      const unitType = choices[choices.length - 1]!; // bias to most expensive affordable
      out.push({
        type: 'BUILD',
        at: { x, y },
        unitType,
        owner: player as 0 | 1,
      });
    }
  }
  return out;
}

function occupied(state: GameState, x: number, y: number): boolean {
  for (const u of Object.values(state.units)) {
    if (u.loadedIn !== undefined) continue;
    if (u.pos.x === x && u.pos.y === y) return true;
  }
  return false;
}

// Exported for tests / debugging.
export const __test = { INCOME_TERRAIN };
