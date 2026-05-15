// Legality checks for every action. Returns a discriminated result so the
// reason can be logged. The reducer treats illegal actions as NO-OPS (the
// state is returned unchanged) and logs the reason — chosen over throwing to
// keep AI/UI integration tolerant of stale clicks and exploratory probes.

import type { Action, GameState, LegalityResult, Unit } from './types';
import { coordEq, inBounds, isCapturable, manhattan, tileAt, unitAt } from './types';
import { TERRAIN, UNITS } from '../data';
import { validatePath, validateLoadPath } from '../systems/pathfinding';

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
    case 'LOAD':
      return checkLoad(state, action);
    case 'UNLOAD':
      return checkUnload(state, action);
    case 'DIVE':
      return checkDive(state, action);
    case 'SURFACE':
      return checkSurface(state, action);
    case 'END_TURN':
      return { legal: true };
    default:
      return illegal('unknown action type');
  }
}

function checkDive(
  state: GameState,
  action: Extract<Action, { type: 'DIVE' }>,
): LegalityResult {
  const u = findUnit(state, action.unitId);
  if (!u) return illegal('unknown unit');
  if (u.owner !== state.currentPlayer) return illegal('not owner');
  if (u.type !== 'submarine') return illegal('unit is not a submarine');
  if (u.loadedIn !== undefined) return illegal('unit is loaded in a transport');
  if (u.hasActed) return illegal('unit already acted');
  if (u.submerged === true) return illegal('submarine already submerged');
  return { legal: true };
}

function checkSurface(
  state: GameState,
  action: Extract<Action, { type: 'SURFACE' }>,
): LegalityResult {
  const u = findUnit(state, action.unitId);
  if (!u) return illegal('unknown unit');
  if (u.owner !== state.currentPlayer) return illegal('not owner');
  if (u.type !== 'submarine') return illegal('unit is not a submarine');
  if (u.loadedIn !== undefined) return illegal('unit is loaded in a transport');
  if (u.hasActed) return illegal('unit already acted');
  if (u.submerged !== true) return illegal('submarine is not submerged');
  return { legal: true };
}

function checkMove(
  state: GameState,
  action: Extract<Action, { type: 'MOVE' }>,
): LegalityResult {
  const u = findUnit(state, action.unitId);
  if (!u) return illegal('unknown unit');
  if (u.owner !== state.currentPlayer) return illegal('not owner');
  if (u.loadedIn !== undefined) return illegal('unit is loaded in a transport');
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
  if (a.loadedIn !== undefined) return illegal('attacker is loaded in a transport');
  const t = findUnit(state, action.targetId);
  if (!t) return illegal('unknown target');
  if (t.owner === a.owner) return illegal('target is friendly');
  if (t.loadedIn !== undefined) return illegal('target is loaded in a transport');
  const stats = UNITS[a.type];
  // Non-combat units (transports: maxRange=0) cannot attack.
  if (stats.maxRange <= 0) return illegal('unit cannot attack');
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
  if (u.loadedIn !== undefined) return illegal('unit is loaded in a transport');
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
  // Sea-class units can only launch from a factory with an adjacent sea tile,
  // otherwise they'd spawn stranded on land they can't traverse.
  if (UNITS[action.unitType].movementClass === 'sea') {
    const adj = [
      { x: action.at.x - 1, y: action.at.y },
      { x: action.at.x + 1, y: action.at.y },
      { x: action.at.x, y: action.at.y - 1 },
      { x: action.at.x, y: action.at.y + 1 },
    ];
    const coastal = adj.some((n) => {
      const row = state.map[n.y];
      if (!row) return false;
      const t = row[n.x];
      return t !== undefined && t.terrain === 'sea';
    });
    if (!coastal) return illegal('sea-class unit needs adjacent sea tile');
  }
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
  if (u.loadedIn !== undefined) return illegal('unit is loaded in a transport');
  if (u.hasActed) return illegal('unit already acted');
  return { legal: true };
}

function checkLoad(
  state: GameState,
  action: Extract<Action, { type: 'LOAD' }>,
): LegalityResult {
  const cargo = findUnit(state, action.cargoId);
  if (!cargo) return illegal('unknown cargo unit');
  const transport = findUnit(state, action.transportId);
  if (!transport) return illegal('unknown transport unit');
  if (cargo.owner !== state.currentPlayer) return illegal('cargo not owned by current player');
  if (transport.owner !== state.currentPlayer) return illegal('transport not owned by current player');
  if (cargo.id === transport.id) return illegal('cannot load unit into itself');
  if (cargo.loadedIn !== undefined) return illegal('cargo is already loaded');
  if (cargo.hasMoved) return illegal('cargo already moved');
  if (cargo.hasActed) return illegal('cargo already acted');
  const tStats = UNITS[transport.type];
  if (tStats.cargoCapacity <= 0) return illegal('target is not a transport');
  const cStats = UNITS[cargo.type];
  if (!tStats.cargoMovementClasses.includes(cStats.movementClass)) {
    return illegal(`transport does not accept ${cStats.movementClass} units`);
  }
  const carried = transport.cargo?.length ?? 0;
  if (carried >= tStats.cargoCapacity) return illegal('transport at capacity');
  // Path must end on the transport's tile.
  if (action.path.length === 0) return illegal('empty path');
  const last = action.path[action.path.length - 1];
  if (!last) return illegal('empty path');
  if (!coordEq(last, transport.pos)) {
    return illegal('LOAD path must end on the transport tile');
  }
  // validateLoadPath allows the destination to be occupied by the named
  // transport (the only case where stopping on a friendly unit is legal).
  const r = validateLoadPath(state, cargo, action.path, transport.id);
  if (!r.ok) return illegal(r.reason);
  return { legal: true };
}

function checkUnload(
  state: GameState,
  action: Extract<Action, { type: 'UNLOAD' }>,
): LegalityResult {
  const transport = findUnit(state, action.transportId);
  if (!transport) return illegal('unknown transport unit');
  if (transport.owner !== state.currentPlayer) return illegal('transport not owned by current player');
  if (transport.hasActed) return illegal('transport already acted');
  const cargo = findUnit(state, action.cargoId);
  if (!cargo) return illegal('unknown cargo unit');
  if (cargo.loadedIn !== transport.id) {
    return illegal('cargo is not loaded in this transport');
  }
  // Destination must be in-bounds, adjacent, unoccupied, passable for cargo.
  if (!inBounds(state.map, action.destination)) {
    return illegal('destination out of bounds');
  }
  const d = manhattan(transport.pos, action.destination);
  if (d !== 1) return illegal('destination must be adjacent to transport');
  const occ = unitAt(state, action.destination);
  if (occ) return illegal('destination occupied');
  const tile = tileAt(state.map, action.destination);
  const cStats = UNITS[cargo.type];
  const moveCost = TERRAIN[tile.terrain].moveCost[cStats.movementClass];
  if (!Number.isFinite(moveCost)) {
    return illegal('destination terrain impassable for cargo');
  }
  return { legal: true };
}
