// Legality checks for every action. Returns a discriminated result so the
// reason can be logged. The reducer treats illegal actions as NO-OPS (the
// state is returned unchanged) and logs the reason — chosen over throwing to
// keep AI/UI integration tolerant of stale clicks and exploratory probes.

import type { Action, GameState, LegalityResult, Unit } from './types';
import { coordEq, inBounds, isCapturable, manhattan, tileAt, unitAt } from './types';
import { UNITS } from '../data-inline';
import { validatePath } from '../systems/pathfinding';

function findUnit(state: GameState, id: string): Unit | undefined {
  return state.units[id];
}

function illegal(reason: string): LegalityResult {
  return { legal: false, reason };
}

export function isLegalAction(state: GameState, action: Action): LegalityResult {
  if (state.winner !== null) return illegal('game over');

  switch (action.type) {
    case 'MOVE':
      return checkMove(state, action);
    case 'ATTACK':
      return checkAttack(state, action);
    case 'CAPTURE':
      return checkCapture(state, action);
    case 'BUILD':
      return checkBuild(state, action);
    case 'WAIT':
      return checkWait(state, action);
    case 'END_TURN':
      return { legal: true };
    default:
      return illegal('unknown action type');
  }
}

function checkMove(
  state: GameState,
  action: Extract<Action, { type: 'MOVE' }>,
): LegalityResult {
  const u = findUnit(state, action.unitId);
  if (!u) return illegal('unknown unit');
  if (u.owner !== state.currentPlayer) return illegal('not owner');
  if (u.hasMoved) return illegal('unit already moved');
  if (u.hasActed) return illegal('unit already acted');
  if (action.path.length === 0) return illegal('empty path');
  const last = action.path[action.path.length - 1];
  if (!last) return illegal('empty path');
  if (!inBounds(state.map, last)) return illegal('destination out of bounds');
  // Cannot stay in place.
  if (coordEq(last, u.pos)) return illegal('destination equals origin');
  const r = validatePath(state, u, action.path);
  if (!r.ok) return illegal(r.reason);
  return { legal: true };
}

function checkAttack(
  state: GameState,
  action: Extract<Action, { type: 'ATTACK' }>,
): LegalityResult {
  const a = findUnit(state, action.attackerId);
  if (!a) return illegal('unknown attacker');
  if (a.owner !== state.currentPlayer) return illegal('not owner');
  if (a.hasActed) return illegal('attacker already acted');
  const t = findUnit(state, action.targetId);
  if (!t) return illegal('unknown target');
  if (t.owner === a.owner) return illegal('target is friendly');
  const stats = UNITS[a.type];
  // Indirect units cannot move and attack in the same turn.
  if (stats.indirect && a.hasMoved) {
    return illegal('indirect unit cannot move and attack');
  }
  const d = manhattan(a.pos, t.pos);
  if (d < stats.minRange || d > stats.maxRange) {
    return illegal(`target out of range (d=${d}, range=${stats.minRange}-${stats.maxRange})`);
  }
  return { legal: true };
}

function checkCapture(
  state: GameState,
  action: Extract<Action, { type: 'CAPTURE' }>,
): LegalityResult {
  const u = findUnit(state, action.unitId);
  if (!u) return illegal('unknown unit');
  if (u.owner !== state.currentPlayer) return illegal('not owner');
  if (u.hasActed) return illegal('unit already acted');
  const stats = UNITS[u.type];
  if (!stats.canCapture) return illegal('unit cannot capture');
  const tile = tileAt(state.map, u.pos);
  if (!isCapturable(tile.terrain)) return illegal('tile not capturable');
  if (tile.owner === u.owner) return illegal('tile already owned');
  return { legal: true };
}

function checkBuild(
  state: GameState,
  action: Extract<Action, { type: 'BUILD' }>,
): LegalityResult {
  if (action.owner !== state.currentPlayer) return illegal('not current player');
  if (!inBounds(state.map, action.at)) return illegal('out of bounds');
  const tile = tileAt(state.map, action.at);
  if (tile.terrain !== 'factory') return illegal('tile is not a factory');
  if (tile.owner !== action.owner) return illegal('factory not owned by player');
  if (unitAt(state, action.at)) return illegal('factory occupied');
  const cost = UNITS[action.unitType].cost;
  const funds = state.players[action.owner].funds;
  if (funds < cost) return illegal(`insufficient funds (${funds} < ${cost})`);
  return { legal: true };
}

function checkWait(
  state: GameState,
  action: Extract<Action, { type: 'WAIT' }>,
): LegalityResult {
  const u = findUnit(state, action.unitId);
  if (!u) return illegal('unknown unit');
  if (u.owner !== state.currentPlayer) return illegal('not owner');
  if (u.hasActed) return illegal('unit already acted');
  return { legal: true };
}
