// Mouse-driven state machine that bridges click events to engine actions.
//
// Flow per the PLAN.md spec:
//   idle
//     ── click own unit ──▶ unit-selected (show move range)
//     ── click factory tile (own, unoccupied) ──▶ build-menu-open
//
//   unit-selected
//     ── click in-range tile ──▶ move-previewed (show path; click again commits MOVE)
//     ── click off-range or own unit again ──▶ idle / new selection
//     ── if unit hasMoved already ──▶ action-menu (skip MOVE)
//
//   move-previewed
//     ── click previewed tile ──▶ commit MOVE, then action-menu
//     ── click a different in-range tile ──▶ update preview
//     ── click off-range ──▶ idle
//
//   action-menu
//     ── click Attack ──▶ attack-targeting
//     ── click Capture ──▶ commit CAPTURE, then idle
//     ── click Wait ──▶ commit WAIT, then idle
//
//   attack-targeting
//     ── hover enemy in range ──▶ damage preview tooltip
//     ── click enemy in range ──▶ commit ATTACK, then idle
//
//   build-menu-open
//     ── click affordable entry ──▶ commit BUILD, then idle
//
// Right-click / Esc / clicking outside menus cancels back to idle.
//
// Input is locked while animations are in progress (`animQueue.busy()`); we
// simply ignore mouse events during that window — see PLAN.md "lock or queue".

import type {
  Action,
  Coord,
  GameState,
  PlayerId,
  Unit,
} from '../engine/core/types';
import { coordEq, inBounds, isCapturable, tileAt, unitAt } from '../engine/core/types';
import { TERRAIN, UNITS } from '../engine/data';
import {
  attackableTargets,
  reachableTiles,
} from '../engine/queries/selectors';
import type { ReachableTile } from '../engine/systems/pathfinding';
import { previewAttack } from '../engine/systems/combat';
import { log } from '../engine/core/logger';
import type { CanvasRenderer, Overlay } from './canvas';
import type { Emitter } from './emitter';
import type { AnimationQueue } from './animations';
import { buildMenuEntries, createHud } from './hud';
import type { ActionMenuEntry, BuildMenuEntry } from './canvas';

export type InputState =
  | { kind: 'idle' }
  | {
      kind: 'unit-selected';
      unit: Unit;
      reachable: ReachableTile[];
    }
  | {
      kind: 'move-previewed';
      unit: Unit;
      reachable: ReachableTile[];
      destination: Coord;
      path: Coord[];
    }
  | {
      kind: 'action-menu';
      unit: Unit;
      /** Tile the unit currently stands on (after MOVE). */
      anchor: Coord;
      entries: ActionMenuEntry[];
    }
  | {
      kind: 'attack-targeting';
      unit: Unit;
      targets: Unit[];
      hover: Unit | null;
    }
  | {
      // Transport's UNLOAD-target picker: like attack-targeting but the
      // targets are adjacent tiles into which the (single, for now) cargo
      // unit can disembark.
      kind: 'unload-targeting';
      transport: Unit;
      cargo: Unit;
      destinations: Coord[];
    }
  | {
      kind: 'build-menu-open';
      tile: Coord;
      entries: BuildMenuEntry[];
    };

export type InputController = {
  /** Current state machine node. Exposed for tests + debugging. */
  getState(): InputState;
  /** Compute the overlay needed for the current state machine + game state. */
  getOverlay(): Overlay;
  /** Synthetic click for tests: CSS-pixel coordinates. */
  click(x: number, y: number, button?: number): void;
  /** Synthetic hover for tests. */
  hover(x: number, y: number): void;
  /** Cancel back to idle (right-click / Esc). */
  cancel(): void;
  /** Programmatic transition for tests. */
  selectUnit(unit: Unit): void;
};

export function createInputController(
  renderer: CanvasRenderer,
  emitter: Emitter,
  animQueue: AnimationQueue,
): InputController {
  let inputState: InputState = { kind: 'idle' };
  const hud = createHud(renderer);

  function logTransition(from: string, to: string, extra?: Record<string, unknown>): void {
    log('render', 'state transition', { from, to, ...extra });
  }

  function getOverlay(): Overlay {
    const state = emitter.getState();
    const ov: Overlay = {};
    // Highlight player-owned capturable tiles faintly so the human sees what's
    // worth stepping on. Cheap O(map) — no big deal.
    const capturable: Coord[] = [];
    for (let y = 0; y < state.map.length; y++) {
      const row = state.map[y]!;
      for (let x = 0; x < row.length; x++) {
        const tile = row[x]!;
        if (isCapturable(tile.terrain) && tile.owner !== state.currentPlayer) {
          capturable.push({ x, y });
        }
      }
    }
    ov.capturable = capturable;

    switch (inputState.kind) {
      case 'idle':
        break;
      case 'unit-selected': {
        const sel = inputState; // narrowed alias for closure
        ov.selected = sel.unit.pos;
        ov.moveRange = sel.reachable
          .filter((r) => r.path.length > 0 || coordEq(r.coord, sel.unit.pos))
          .map((r) => r.coord);
        break;
      }
      case 'move-previewed':
        ov.selected = inputState.unit.pos;
        ov.moveRange = inputState.reachable.map((r) => r.coord);
        ov.movePath = inputState.path;
        break;
      case 'action-menu':
        ov.selected = inputState.anchor;
        ov.actionMenu = { tile: inputState.anchor, entries: inputState.entries };
        break;
      case 'attack-targeting': {
        ov.selected = inputState.unit.pos;
        ov.attackRange = inputState.targets.map((t) => t.pos);
        if (inputState.hover) {
          const dmg = previewAttack(state, inputState.unit.id, inputState.hover.id);
          ov.damagePreview = {
            tile: inputState.hover.pos,
            dealt: dmg.dealt,
            received: dmg.counterReceived,
          };
        }
        break;
      }
      case 'unload-targeting': {
        ov.selected = inputState.transport.pos;
        // Re-use the moveRange overlay (blue tint) for unload destinations —
        // visually distinct from the red attack-range and the player's eye
        // is already trained to read blue as "where this unit acts".
        ov.moveRange = inputState.destinations;
        break;
      }
      case 'build-menu-open':
        ov.buildMenu = { tile: inputState.tile, entries: inputState.entries };
        break;
    }
    return ov;
  }

  function setState(next: InputState, from: string): void {
    inputState = next;
    logTransition(from, next.kind);
    emitter.emit({ type: 'stateChanged', state: emitter.getState(), action: null });
  }

  function cancel(): void {
    if (inputState.kind !== 'idle') {
      setState({ kind: 'idle' }, inputState.kind);
    }
  }

  function selectUnit(unit: Unit): void {
    const state = emitter.getState();
    // If the unit has already moved but not acted, we skip to the action menu.
    if (unit.hasMoved && !unit.hasActed) {
      openActionMenuFor(unit, unit.pos);
      return;
    }
    if (unit.hasActed) {
      // Cannot do anything with this unit — leave selection idle.
      log('render', 'unit already acted; ignoring select', { id: unit.id });
      return;
    }
    const reachable = reachableTiles(state, unit);
    setState({ kind: 'unit-selected', unit, reachable }, inputState.kind);
  }

  function openActionMenuFor(unit: Unit, anchor: Coord): void {
    const entries = computeActionMenuEntries(emitter.getState(), unit, anchor);
    if (entries.length === 0) {
      // Nothing to do — auto-wait.
      emitter.dispatch({ type: 'WAIT', unitId: unit.id });
      setState({ kind: 'idle' }, inputState.kind);
      return;
    }
    setState(
      { kind: 'action-menu', unit, anchor, entries },
      inputState.kind,
    );
  }

  function handleHover(x: number, y: number): void {
    if (inputState.kind !== 'attack-targeting') return;
    const tile = renderer.pixelToTile(x, y);
    if (!tile) {
      if (inputState.hover !== null) {
        inputState = { ...inputState, hover: null };
        emitter.emit({ type: 'stateChanged', state: emitter.getState(), action: null });
      }
      return;
    }
    const enemy = inputState.targets.find((t) => coordEq(t.pos, tile)) ?? null;
    if (enemy !== inputState.hover) {
      inputState = { ...inputState, hover: enemy };
      emitter.emit({ type: 'stateChanged', state: emitter.getState(), action: null });
    }
  }

  function click(x: number, y: number, button: number = 0): void {
    if (button === 2) {
      cancel();
      return;
    }
    if (animQueue.busy()) {
      log('render', 'input ignored: animations in progress');
      return;
    }
    const state = emitter.getState();
    if (state.winner !== null) return;

    // HUD has priority.
    const hudHit = hud.hit(x, y, state, getOverlay());
    if (hudHit) {
      onHudClick(hudHit);
      return;
    }

    const tile = renderer.pixelToTile(x, y);
    if (!tile) {
      cancel();
      return;
    }
    if (
      tile.y >= state.map.length ||
      !state.map[tile.y] ||
      tile.x >= (state.map[tile.y]?.length ?? 0)
    ) {
      cancel();
      return;
    }

    onTileClick(tile);
  }

  function onHudClick(target: ReturnType<typeof hud.hit> & object): void {
    if (target.kind === 'action-menu' && inputState.kind === 'action-menu') {
      const entry = target.entry;
      if (!entry.enabled) return;
      const unit = inputState.unit;
      if (entry.label === 'Attack') {
        const targets = attackableTargets(emitter.getState(), unit);
        setState(
          { kind: 'attack-targeting', unit, targets, hover: null },
          'action-menu',
        );
      } else if (entry.label === 'Capture') {
        commit({ type: 'CAPTURE', unitId: unit.id });
        setState({ kind: 'idle' }, 'action-menu');
      } else if (entry.label === 'Wait') {
        commit({ type: 'WAIT', unitId: unit.id });
        setState({ kind: 'idle' }, 'action-menu');
      } else if (entry.label === 'Unload') {
        // Transport with cargo. For v1 we only support cargoCapacity=1, so
        // there is at most one cargo unit and the picker just chooses an
        // adjacent destination tile. The cargo to UNLOAD is the first in
        // the manifest.
        const state = emitter.getState();
        const carrier = state.units[unit.id];
        const cargoId = carrier?.cargo?.[0];
        if (!carrier || !cargoId) return;
        const cargo = state.units[cargoId];
        if (!cargo) return;
        const destinations = adjacentUnloadDestinations(state, carrier, cargo);
        if (destinations.length === 0) return;
        setState(
          { kind: 'unload-targeting', transport: carrier, cargo, destinations },
          'action-menu',
        );
      }
      return;
    }
    if (target.kind === 'build-menu' && inputState.kind === 'build-menu-open') {
      const entry = target.entry;
      if (!entry.affordable) return;
      const state = emitter.getState();
      commit({
        type: 'BUILD',
        at: inputState.tile,
        unitType: entry.unitType,
        owner: state.currentPlayer,
      });
      setState({ kind: 'idle' }, 'build-menu-open');
    }
  }

  function onTileClick(tile: Coord): void {
    const state = emitter.getState();
    const occupant = unitAt(state, tile);

    switch (inputState.kind) {
      case 'idle': {
        // Factory click for build?
        const t = tileAt(state.map, tile);
        if (
          t.terrain === 'factory' &&
          t.owner === state.currentPlayer &&
          !occupant
        ) {
          const entries = buildMenuEntries(state, state.currentPlayer);
          log('render', 'build menu open', { tile });
          setState({ kind: 'build-menu-open', tile, entries }, 'idle');
          return;
        }
        if (occupant && occupant.owner === state.currentPlayer) {
          selectUnit(occupant);
        }
        return;
      }
      case 'unit-selected': {
        const unit = inputState.unit;
        // Re-clicking own unit (stay-in-place) opens the action menu so the
        // unit can Capture/Attack/Wait without moving. Right-click or Esc to
        // cancel selection.
        if (occupant && occupant.id === unit.id) {
          openActionMenuFor(unit, unit.pos);
          return;
        }
        // Click a friendly transport-with-capacity that's in our reach ->
        // dispatch a LOAD (single action that absorbs the MOVE).
        if (
          occupant &&
          occupant.owner === state.currentPlayer &&
          occupant.id !== unit.id &&
          isLoadable(occupant, unit)
        ) {
          const reach = inputState.reachable.find((r) => coordEq(r.coord, tile));
          if (reach && reach.path.length > 0) {
            commit({
              type: 'LOAD',
              cargoId: unit.id,
              transportId: occupant.id,
              path: reach.path,
            });
            setState({ kind: 'idle' }, 'unit-selected');
            return;
          }
        }
        // Click another own unit -> switch selection.
        if (occupant && occupant.owner === state.currentPlayer) {
          selectUnit(occupant);
          return;
        }
        // Click a reachable tile -> preview move.
        const reach = inputState.reachable.find((r) => coordEq(r.coord, tile));
        if (reach && reach.path.length > 0) {
          setState(
            {
              kind: 'move-previewed',
              unit,
              reachable: inputState.reachable,
              destination: tile,
              path: reach.path,
            },
            'unit-selected',
          );
          return;
        }
        // Off-range -> cancel.
        cancel();
        return;
      }
      case 'move-previewed': {
        const unit = inputState.unit;
        if (coordEq(tile, inputState.destination)) {
          // Commit move, then open action menu at the new tile.
          const ok = commit({ type: 'MOVE', unitId: unit.id, path: inputState.path });
          if (!ok) {
            cancel();
            return;
          }
          // Need to look up the unit again after dispatch (positions changed).
          const moved = emitter.getState().units[unit.id];
          if (!moved) {
            setState({ kind: 'idle' }, 'move-previewed');
            return;
          }
          openActionMenuFor(moved, moved.pos);
          return;
        }
        const reach = inputState.reachable.find((r) => coordEq(r.coord, tile));
        if (reach && reach.path.length > 0) {
          setState(
            {
              ...inputState,
              destination: tile,
              path: reach.path,
            },
            'move-previewed',
          );
          return;
        }
        cancel();
        return;
      }
      case 'action-menu':
        // Click outside menu cancels.
        cancel();
        return;
      case 'attack-targeting': {
        const enemy = inputState.targets.find((t) => coordEq(t.pos, tile));
        if (!enemy) {
          cancel();
          return;
        }
        commit({ type: 'ATTACK', attackerId: inputState.unit.id, targetId: enemy.id });
        setState({ kind: 'idle' }, 'attack-targeting');
        return;
      }
      case 'unload-targeting': {
        const dest = inputState.destinations.find((c) => coordEq(c, tile));
        if (!dest) {
          cancel();
          return;
        }
        commit({
          type: 'UNLOAD',
          transportId: inputState.transport.id,
          cargoId: inputState.cargo.id,
          destination: dest,
        });
        setState({ kind: 'idle' }, 'unload-targeting');
        return;
      }
      case 'build-menu-open':
        cancel();
        return;
    }
  }

  function commit(action: Action): boolean {
    const before = emitter.getState();
    // Enqueue animation BEFORE dispatching so the renderer can interpolate
    // from the pre-action state while the new state is committed.
    enqueueAnimationFor(before, action);
    const after = emitter.dispatch(action);
    return after !== before;
  }

  function enqueueAnimationFor(state: GameState, action: Action): void {
    if (action.type === 'MOVE') {
      const u = state.units[action.unitId];
      if (!u) return;
      const path = [u.pos, ...action.path];
      animQueue.enqueueMove(action.unitId, path);
      return;
    }
    if (action.type === 'ATTACK') {
      animQueue.enqueueAttack(action.attackerId, action.targetId);
      const target = state.units[action.targetId];
      const attacker = state.units[action.attackerId];
      if (!target || !attacker) return;
      // Predict death + HP tween + camera shake so the renderer can react.
      const dmg = previewAttack(state, action.attackerId, action.targetId);
      const targetFinalHp = Math.max(0, target.hp - dmg.dealt);
      const attackerFinalHp = Math.max(0, attacker.hp - dmg.counterReceived);
      // Camera shake when either side takes a >40 HP hit.
      if (dmg.dealt > 40 || dmg.counterReceived > 40) {
        animQueue.enqueueShake();
      }
      // HP tween for survivors; the death fade replaces the bar for the fallen.
      if (targetFinalHp > 0) {
        animQueue.enqueueHpTween(target.id, target.hp, targetFinalHp);
      }
      if (attackerFinalHp > 0 && dmg.counterReceived > 0) {
        animQueue.enqueueHpTween(attacker.id, attacker.hp, attackerFinalHp);
      }
      if (targetFinalHp <= 0) {
        animQueue.enqueueDeath(target.id, target.pos);
      } else if (attackerFinalHp <= 0) {
        animQueue.enqueueDeath(attacker.id, attacker.pos);
      }
    }
  }

  // ─────────────────────────── DOM bindings ──────────────────────────────────
  const canvas = renderer.canvas;
  canvas.addEventListener('click', (e) => click(e.offsetX, e.offsetY, 0));
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    click(e.offsetX, e.offsetY, 2);
  });
  canvas.addEventListener('mousemove', (e) => handleHover(e.offsetX, e.offsetY));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel();
    else if (e.key === 'Enter' && emitter.getState().winner === null) {
      emitter.dispatch({ type: 'END_TURN' });
      setState({ kind: 'idle' }, inputState.kind);
    }
  });

  return {
    getState(): InputState {
      return inputState;
    },
    getOverlay,
    click,
    hover: handleHover,
    cancel,
    selectUnit,
  };
}

// ─────────────────────────── Helpers ─────────────────────────────────────────

function computeActionMenuEntries(
  state: GameState,
  unit: Unit,
  anchor: Coord,
): ActionMenuEntry[] {
  const entries: ActionMenuEntry[] = [];

  // Attack: any enemy in range and the unit can still act. Indirect units lose
  // the attack option if they've moved this turn.
  const stats = UNITS[unit.type];
  const canAttack =
    !unit.hasActed &&
    stats.maxRange > 0 &&
    (!stats.indirect || !unit.hasMoved) &&
    attackableTargets(state, unit).length > 0;
  if (canAttack) entries.push({ label: 'Attack', enabled: true });

  // Capture: infantry on an enemy/neutral capturable tile.
  if (stats.canCapture && !unit.hasActed) {
    const tile = tileAt(state.map, anchor);
    if (isCapturable(tile.terrain) && tile.owner !== unit.owner) {
      entries.push({ label: 'Capture', enabled: true });
    }
  }

  // Unload: transports carrying cargo, with at least one valid adjacent
  // destination tile. Per AW convention this is offered after the
  // transport's MOVE (or in place of a MOVE if it stays put).
  if (!unit.hasActed && stats.cargoCapacity > 0 && unit.cargo && unit.cargo.length > 0) {
    const cargoId = unit.cargo[0];
    const cargo = cargoId ? state.units[cargoId] : undefined;
    if (cargo) {
      const dests = adjacentUnloadDestinations(state, unit, cargo);
      if (dests.length > 0) entries.push({ label: 'Unload', enabled: true });
    }
  }

  // Wait: always available so the player can park the unit.
  entries.push({ label: 'Wait', enabled: !unit.hasActed });
  return entries;
}

/**
 * True if `cargo` can legally LOAD into `transport`:
 *   - transport has capacity,
 *   - transport accepts cargo's movement class.
 */
function isLoadable(transport: Unit, cargo: Unit): boolean {
  const tStats = UNITS[transport.type];
  if (tStats.cargoCapacity <= 0) return false;
  const cStats = UNITS[cargo.type];
  if (!tStats.cargoMovementClasses.includes(cStats.movementClass)) return false;
  const carried = transport.cargo?.length ?? 0;
  return carried < tStats.cargoCapacity;
}

/**
 * Adjacent tiles (4-neighbour) onto which `cargo` can disembark from
 * `transport`. A tile is valid if it's in-bounds, unoccupied, and passable
 * for the cargo's movement class.
 */
function adjacentUnloadDestinations(
  state: GameState,
  transport: Unit,
  cargo: Unit,
): Coord[] {
  const out: Coord[] = [];
  const cls = UNITS[cargo.type].movementClass;
  const deltas: ReadonlyArray<Coord> = [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
  ];
  for (const d of deltas) {
    const c: Coord = { x: transport.pos.x + d.x, y: transport.pos.y + d.y };
    if (!inBounds(state.map, c)) continue;
    if (unitAt(state, c)) continue;
    const tile = tileAt(state.map, c);
    const cost = TERRAIN[tile.terrain].moveCost[cls];
    if (!Number.isFinite(cost)) continue;
    out.push(c);
  }
  return out;
}

// Expose the helper for tests.
export const __test = { computeActionMenuEntries, isLoadable, adjacentUnloadDestinations };
export type { PlayerId };
