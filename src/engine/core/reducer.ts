// Pure (state, action) => state reducer.
//
// Contract:
// - Always returns a new state object via `structuredClone`. Inputs never
//   mutated.
// - Illegal actions are NO-OPS: the original state is returned unchanged and
//   the rejection reason is logged. (See validators.ts for rationale.)
// - After every legal action (including END_TURN), the win condition is
//   evaluated; if a winner is detected, `state.winner` is set. Once a winner
//   is set, all subsequent actions are rejected.
//
// Action semantics (per PLAN.md):
// - MOVE: validate path, relocate unit, mark hasMoved. Does not consume the
//   unit's action. If the unit moves OFF a capturable tile, its
//   captureProgress resets.
// - ATTACK: applies damage, resolves counter, marks unit as
//   hasMoved + hasActed. Removes destroyed units.
// - CAPTURE: accumulates progress, possibly flips ownership, marks
//   hasMoved + hasActed.
// - BUILD: spawns a unit on the factory tile with hasMoved + hasActed (built
//   units act next turn). Deducts funds.
// - WAIT: marks hasMoved + hasActed.
// - END_TURN: grants income to the *current* player, then advances
//   currentPlayer, resets the new currentPlayer's units' flags, increments
//   `turn`.

import type { Action, GameState, PlayerId, Unit, UnitId } from './types';
import { coordEq, isCapturable, otherPlayer, tileAt } from './types';
import { isLegalAction } from './validators';
import { log } from './logger';
import { validatePath } from '../systems/pathfinding';
import { resolveAttack } from '../systems/combat';
import { resetCapture, resolveCapture } from '../systems/capture';
import { grantIncome } from '../systems/economy';
import { checkWinner } from '../systems/win';
import { UNITS } from '../data';

export function reduce(state: GameState, action: Action): GameState {
  log('engine', 'action dispatched', action);
  if (state.winner !== null) {
    log('engine', 'action rejected', { reason: 'game over', action });
    return state;
  }
  const legality = isLegalAction(state, action);
  if (!legality.legal) {
    log('engine', 'action rejected', { reason: legality.reason, action });
    return state;
  }

  const next: GameState = structuredClone(state);

  switch (action.type) {
    case 'MOVE':
      applyMove(next, action);
      break;
    case 'ATTACK':
      applyAttack(next, action);
      break;
    case 'CAPTURE':
      applyCapture(next, action);
      break;
    case 'BUILD':
      applyBuild(next, action);
      break;
    case 'WAIT':
      applyWait(next, action);
      break;
    case 'LOAD':
      applyLoad(next, action);
      break;
    case 'UNLOAD':
      applyUnload(next, action);
      break;
    case 'DIVE':
      applyDive(next, action);
      break;
    case 'SURFACE':
      applySurface(next, action);
      break;
    case 'END_TURN':
      applyEndTurn(next);
      break;
  }

  // Detect win after every action.
  const winner = checkWinner(next);
  if (winner !== null && next.winner === null) {
    next.winner = winner;
    log('engine', 'winner set', { winner });
  }
  return next;
}

function applyMove(
  state: GameState,
  action: Extract<Action, { type: 'MOVE' }>,
): void {
  const u = state.units[action.unitId];
  if (!u) return;
  const r = validatePath(state, u, action.path);
  if (!r.ok) {
    // Should have been caught by validator; bail safely.
    log('engine', 'move validation failed in apply', { reason: r.reason });
    return;
  }
  const dest = action.path[action.path.length - 1];
  if (!dest) return;
  const movedOff = !coordEq(dest, u.pos);
  u.pos = { x: dest.x, y: dest.y };
  u.hasMoved = true;
  if (movedOff) resetCapture(u);
  // Cargo pos tracks the transport's pos for sanity.
  if (u.cargo && u.cargo.length > 0) {
    for (const cid of u.cargo) {
      const c = state.units[cid];
      if (c) c.pos = { x: dest.x, y: dest.y };
    }
  }
  log('engine', 'unit moved', { id: u.id, to: u.pos, cost: r.cost });
}

function applyAttack(
  state: GameState,
  action: Extract<Action, { type: 'ATTACK' }>,
): void {
  const a = state.units[action.attackerId];
  const t = state.units[action.targetId];
  if (!a || !t) return;
  const res = resolveAttack(state, a, t);
  // Remove destroyed units. When a transport is destroyed, every cargo unit
  // listed in its manifest is also destroyed (units cannot survive the loss
  // of their carrier).
  if (res.defenderDestroyed) {
    destroyUnit(state, t.id);
  }
  if (res.attackerDestroyed) {
    destroyUnit(state, a.id);
    return; // attacker gone, no flag updates needed
  }
  a.hasMoved = true;
  a.hasActed = true;
}

/** Remove a unit (and its cargo, if it's a transport) from state.units. */
function destroyUnit(state: GameState, id: UnitId): void {
  const u = state.units[id];
  if (!u) return;
  if (u.cargo && u.cargo.length > 0) {
    for (const cid of [...u.cargo]) {
      // Recurse only one level — cargo can't itself carry cargo in v1.
      delete state.units[cid];
      log('engine', 'unit destroyed', { id: cid, reason: 'carrier lost' });
    }
  }
  delete state.units[id];
}

function applyCapture(
  state: GameState,
  action: Extract<Action, { type: 'CAPTURE' }>,
): void {
  const u = state.units[action.unitId];
  if (!u) return;
  resolveCapture(state, u);
  u.hasMoved = true;
  u.hasActed = true;
}

function applyBuild(
  state: GameState,
  action: Extract<Action, { type: 'BUILD' }>,
): void {
  const cost = UNITS[action.unitType].cost;
  const ps = state.players[action.owner];
  ps.funds -= cost;
  const id: UnitId = `u${state.nextUnitId++}`;
  const unit: Unit = {
    id,
    type: action.unitType,
    owner: action.owner,
    pos: { x: action.at.x, y: action.at.y },
    hp: 100,
    hasMoved: true,
    hasActed: true,
    captureProgress: 0,
  };
  state.units[id] = unit;
  log('engine', 'unit built', { id, type: action.unitType, at: action.at, cost });
}

function applyWait(
  state: GameState,
  action: Extract<Action, { type: 'WAIT' }>,
): void {
  const u = state.units[action.unitId];
  if (!u) return;
  u.hasMoved = true;
  u.hasActed = true;
  log('engine', 'unit waited', { id: u.id });
}

function applyLoad(
  state: GameState,
  action: Extract<Action, { type: 'LOAD' }>,
): void {
  const cargo = state.units[action.cargoId];
  const transport = state.units[action.transportId];
  if (!cargo || !transport) return;
  // Cargo moves onto the transport's tile, then is loaded.
  cargo.pos = { x: transport.pos.x, y: transport.pos.y };
  cargo.loadedIn = transport.id;
  cargo.hasMoved = true;
  cargo.hasActed = true;
  resetCapture(cargo); // entering a transport breaks any active capture
  if (!transport.cargo) transport.cargo = [];
  transport.cargo.push(cargo.id);
  log('engine', 'unit loaded', { cargo: cargo.id, transport: transport.id });
}

function applyUnload(
  state: GameState,
  action: Extract<Action, { type: 'UNLOAD' }>,
): void {
  const transport = state.units[action.transportId];
  const cargo = state.units[action.cargoId];
  if (!transport || !cargo) return;
  // Drop cargo onto destination tile; remove from transport manifest.
  cargo.pos = { x: action.destination.x, y: action.destination.y };
  delete cargo.loadedIn;
  cargo.hasMoved = true;
  cargo.hasActed = true;
  if (transport.cargo) {
    transport.cargo = transport.cargo.filter((id) => id !== cargo.id);
  }
  // Standard AW rule: transport itself is marked acted by UNLOAD even if it
  // hadn't moved this turn — UNLOAD consumes its action.
  transport.hasMoved = true;
  transport.hasActed = true;
  log('engine', 'unit unloaded', {
    cargo: cargo.id,
    transport: transport.id,
    to: cargo.pos,
  });
}

function applyDive(
  state: GameState,
  action: Extract<Action, { type: 'DIVE' }>,
): void {
  const u = state.units[action.unitId];
  if (!u) return;
  u.submerged = true;
  u.hasMoved = true;
  u.hasActed = true;
  log('engine', 'unit dived', { id: u.id });
}

function applySurface(
  state: GameState,
  action: Extract<Action, { type: 'SURFACE' }>,
): void {
  const u = state.units[action.unitId];
  if (!u) return;
  u.submerged = false;
  u.hasMoved = true;
  u.hasActed = true;
  log('engine', 'unit surfaced', { id: u.id });
}

function applyEndTurn(state: GameState): void {
  // 1. Auto-capture: any infantry of the ending player still standing on a
  //    non-owned capturable tile that hasn't acted this turn continues its
  //    capture. Matches genre convention (Advance Wars / Wargroove): once you
  //    start capturing, you keep capturing unless you move or do something
  //    else. The player overrides by selecting the unit and choosing another
  //    action during their turn.
  for (const u of Object.values(state.units)) {
    if (u.owner !== state.currentPlayer) continue;
    if (u.hasActed) continue;
    if (u.loadedIn !== undefined) continue; // loaded units never auto-capture
    if (!UNITS[u.type].canCapture) continue;
    const tile = tileAt(state.map, u.pos);
    if (!isCapturable(tile.terrain) || tile.owner === u.owner) continue;
    resolveCapture(state, u);
    u.hasMoved = true;
    u.hasActed = true;
  }
  // 2. Income for the player whose turn just ended.
  grantIncome(state, state.currentPlayer);
  // 3. Advance.
  const nextPlayer: PlayerId = otherPlayer(state.currentPlayer);
  state.currentPlayer = nextPlayer;
  // 4. Reset new currentPlayer's units' flags. Also reset captureProgress on
  //    any of their units NOT standing on a capturable tile they don't own
  //    (defensive — should already be 0 if invariants hold).
  for (const u of Object.values(state.units)) {
    if (u.owner !== nextPlayer) continue;
    u.hasMoved = false;
    u.hasActed = false;
    const tile = tileAt(state.map, u.pos);
    if (!isCapturable(tile.terrain) || tile.owner === u.owner) {
      u.captureProgress = 0;
    }
  }
  // 5. Bump turn counter (each END_TURN increments; two = a round).
  state.turn += 1;
  log('engine', 'turn ended', {
    newCurrentPlayer: state.currentPlayer,
    turn: state.turn,
  });
}
