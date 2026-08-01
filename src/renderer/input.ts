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
//
// ─── Mobile grammar (opts.grammar === 'mobile') ──────────────────────────────
//
// A second, opt-in grammar for touch: select → stage → commit. It lives beside
// the desktop machine above, never inside it — `click()` routes a tile tap to
// exactly one of the two handlers and every desktop branch is untouched.
//
//   tap 1  selects or inspects. Own unit → unit-selected. Enemy → enemy-inspect
//          (threat overlay ON by default — "what can this thing hit" is the
//          question the tap is asking; the tray button hides it).
//          Terrain/property → tile-inspect.
//          Own empty factory → build-menu-open, same as desktop. NEVER commits.
//   tap 2  stages a verb inferred from what was tapped (mobile/verbs.ts):
//          reachable tile → move-previewed, enemy in reach → attack-staged with
//          an auto-picked firing tile, capturable property → capture-staged.
//          NEVER commits — the board does not change under the player's finger.
//   tap 3  on the SAME staged tile commits, guarded by a 150ms debounce so a
//          double-tap can't fire the action. Tapping a different legal target
//          re-stages instead; anything else deselects.
//
// A commit is a SEQUENCE of the existing engine actions — MOVE then ATTACK, or
// MOVE then CAPTURE — dispatched synchronously in one handler. No new reducer
// action types, no engine changes. If the follow-up after the MOVE is genuinely
// ambiguous (`needsOrders`), the MOVE lands alone and the existing action menu
// opens to ask.

import type {
  Action,
  Coord,
  GameState,
  PlayerId,
  Unit,
  UnitType,
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
import { enqueueAttackEffects } from './attack-effects';
import { buildMenuEntries } from './hud';
import type { ActionMenuEntry, BuildMenuEntry } from './canvas';
import { bestAttackPosition, inferVerb, needsOrders } from './mobile/verbs';

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
      /** Mobile grammar only: clock reading when this move was staged. Absent
       *  under the desktop grammar, which commits on the confirming click with
       *  no debounce. */
      stagedAt?: number;
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
      /** Mobile grammar only: the entry the player has staged but not yet
       *  confirmed. `confirmStaged()` turns it into a BUILD. */
      staged?: UnitType;
    }
  // ── Mobile grammar nodes ──────────────────────────────────────────────────
  // These never occur under the desktop grammar.
  | {
      /** Tap-1 on an enemy unit: pure inspection, no action possible. */
      kind: 'enemy-inspect';
      unit: Unit;
      /** When true, `getOverlay` paints everything this enemy could hit. */
      showThreat: boolean;
    }
  | {
      /** Tap-1 on terrain or a property with nothing selectable on it. */
      kind: 'tile-inspect';
      tile: Coord;
    }
  | {
      /** Tap-2 staged an attack. Committing dispatches MOVE (if `path` is
       *  non-empty) then ATTACK. Forecast: `previewAttack(state, unit.id,
       *  target.id)`. */
      kind: 'attack-staged';
      unit: Unit;
      reachable: ReachableTile[];
      target: Unit;
      /** Tile the unit fires from — `unit.pos` for indirect units. */
      firingPos: Coord;
      /** Path to `firingPos`; empty means fire in place (no MOVE). */
      path: Coord[];
      stagedAt: number;
    }
  | {
      /** Tap-2 staged a capture. Committing dispatches MOVE (if `path` is
       *  non-empty) then CAPTURE. */
      kind: 'capture-staged';
      unit: Unit;
      reachable: ReachableTile[];
      destination: Coord;
      /** Path to `destination`; empty means capture in place (no MOVE). */
      path: Coord[];
      stagedAt: number;
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
  /**
   * Choose an action-menu entry by label. The menus are DOM now (menus.ts) so
   * the branch logic that used to live in `onHudClick` moved here — the DOM
   * button calls this directly. Ignored unless we're in `action-menu` state and
   * the entry exists + is enabled.
   */
  chooseAction(label: ActionMenuEntry['label']): void;
  /**
   * Choose a build-menu entry by unit type. Ignored unless we're in
   * `build-menu-open` state and the entry exists + is affordable.
   */
  chooseBuild(unitType: UnitType): void;
  /**
   * Mobile grammar: commit whatever is currently staged — the tray's Confirm
   * button, equivalent to the third tap but WITHOUT the debounce (an explicit
   * button press is never an accidental double-tap). Handles `move-previewed`,
   * `attack-staged`, `capture-staged` and a staged `build-menu-open`. No-op in
   * every other state.
   */
  confirmStaged(): void;
  /**
   * Mobile grammar: stage a build-menu entry without committing it. Ignored
   * unless we're in `build-menu-open` and the entry exists + is affordable.
   * `confirmStaged()` then routes through the usual `chooseBuild` path.
   */
  stageBuild(unitType: UnitType): void;
  /**
   * Mobile grammar: flip the threat overlay on an `enemy-inspect` node.
   * Ignored in every other state.
   */
  toggleThreat(): void;
};

export function createInputController(
  renderer: CanvasRenderer,
  emitter: Emitter,
  animQueue: AnimationQueue,
  opts?: {
    endTurnAllowed?: () => boolean;
    coarsePointer?: boolean;
    /** Which tap grammar tile clicks route through. Defaults to 'desktop', so
     *  nothing about the existing behaviour changes until a caller opts in. */
    grammar?: 'desktop' | 'mobile';
    /** Clock for the mobile grammar's stage/commit debounce. Injectable for
     *  tests; defaults to wall time. */
    now?: () => number;
  },
): InputController {
  let inputState: InputState = { kind: 'idle' };
  // Gate for the Enter-to-end-turn keybind. Defaults to always-allowed so
  // existing call sites (and tests) that omit it keep the old behaviour;
  // main.ts passes a predicate that refuses while an AI turn is in progress or
  // animations are mid-flight, so a stray Enter can't steal the AI's turn.
  const endTurnAllowed = opts?.endTurnAllowed ?? ((): boolean => true);
  // Coarse-pointer (touch) mode toggles the two-tap attack confirm: the first
  // tap on an enemy previews the damage, a second tap on the SAME enemy commits.
  // Detected once at construction so mid-session it never flips under us; tests
  // inject it directly. Guarded for jsdom, where matchMedia may be absent.
  const coarsePointer =
    opts?.coarsePointer ?? (window.matchMedia?.('(pointer: coarse)').matches ?? false);
  // Tap grammar. 'desktop' keeps the machine documented at the top of this
  // file; 'mobile' routes tile taps through the select → stage → commit
  // handlers below. Fixed at construction — a grammar that flipped mid-gesture
  // would strand the machine in a node the other grammar can't read.
  const grammar: 'desktop' | 'mobile' = opts?.grammar ?? 'desktop';
  const now = opts?.now ?? ((): number => Date.now());

  function logTransition(from: string, to: string, extra?: Record<string, unknown>): void {
    log('render', 'state transition', { from, to, ...extra });
  }

  // `getOverlay` runs every frame (main.ts), and the enemy threat overlay is
  // the one overlay whose input isn't already cached on the input node — it has
  // to path-find from the ENEMY's tile. Memoise on state identity: the reducer
  // hands back a fresh object on every committed action, so a hit means nothing
  // that could move the threat has happened. Same trick as
  // `selectors.visibleTiles`.
  let threatMemo: { state: GameState; unitId: string; area: Coord[] } | null = null;

  function threatAreaFor(state: GameState, enemy: Unit): Coord[] {
    if (threatMemo && threatMemo.state === state && threatMemo.unitId === enemy.id) {
      return threatMemo.area;
    }
    const area = computeAttackArea(state, enemy, reachableTiles(state, enemy));
    threatMemo = { state, unitId: enemy.id, area };
    return area;
  }

  function getOverlay(): Overlay {
    const state = emitter.getState();
    const ov: Overlay = {};
    // Capturable wash: a faint hint of which not-yet-ours capturable tiles are
    // worth stepping on. Gated on a canCapture *selection* (infantry) — it used
    // to be painted under every state, idle included, which left a permanent
    // yellow tint fighting the move/attack overlays for a third simultaneous
    // colour. Now it only appears when the selected unit could actually capture,
    // so idle shows nothing. Cheap O(map) when it does run.
    const selUnit = selectedUnit(inputState);
    if (selUnit && UNITS[selUnit.type].canCapture) {
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
    }

    switch (inputState.kind) {
      case 'idle':
        break;
      case 'unit-selected': {
        const sel = inputState; // narrowed alias for closure
        ov.selected = sel.unit.pos;
        ov.moveRange = sel.reachable
          .filter((r) => r.path.length > 0 || coordEq(r.coord, sel.unit.pos))
          .map((r) => r.coord);
        // Attack fringe = tiles this unit could hit this turn MINUS the tiles it
        // can stand on (see attackFringe). Red thus means strictly "can hit but
        // can't move here" and never stacks over the blue move range, so neither
        // reads as mud. Direct units are left with the 1-tile ring beyond their
        // movement. Indirect units additionally trace their FULL donut with the
        // red border (fills stay subtracted): on open ground the whole donut is
        // reachable, so without the border the "what can I hit if I stay" read
        // would vanish entirely — and firing after moving is exactly what an
        // indirect unit cannot do.
        if (!sel.unit.hasActed) {
          ov.attackRange = attackFringe(state, sel.unit, sel.reachable);
          if (UNITS[sel.unit.type].indirect) {
            ov.attackRangeBorder = computeAttackArea(state, sel.unit, sel.reachable);
          }
        }
        break;
      }
      case 'move-previewed':
        ov.selected = inputState.unit.pos;
        ov.moveRange = inputState.reachable.map((r) => r.coord);
        ov.movePath = inputState.path;
        // Identical attack fringe to unit-selected — one concept, one palette
        // across both states (previously the attack overlay vanished here and
        // the same range flipped to clean blue). Arcs are unioned over the FULL
        // reachable set, not the previewed destination: the MOVE isn't committed
        // yet, so the player is still choosing which tile to fire from.
        if (!inputState.unit.hasActed) {
          ov.attackRange = attackFringe(state, inputState.unit, inputState.reachable);
          if (UNITS[inputState.unit.type].indirect) {
            ov.attackRangeBorder = computeAttackArea(
              state,
              inputState.unit,
              inputState.reachable,
            );
          }
        }
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
      // ── Mobile grammar nodes ────────────────────────────────────────────
      // Every one of these reuses the overlay fields the canvas already knows
      // how to draw — the renderer is untouched by this phase.
      case 'enemy-inspect': {
        const sel = inputState;
        ov.selected = sel.unit.pos;
        if (sel.showThreat) {
          // Threat = everything this enemy could hit if it moved first, which
          // is exactly the attack area over its own reachable set. Fill AND
          // border so it reads at a glance on a small screen.
          const area = threatAreaFor(state, sel.unit);
          ov.attackRange = area;
          ov.attackRangeBorder = area;
        }
        break;
      }
      case 'tile-inspect':
        ov.selected = inputState.tile;
        break;
      case 'attack-staged': {
        const sel = inputState;
        // Firing tile carries the selection ring, the walk to it is the move
        // path, and the victim is the (single-tile) attack range.
        ov.selected = sel.firingPos;
        ov.moveRange = sel.reachable.map((r) => r.coord);
        ov.movePath = sel.path;
        ov.attackRange = [sel.target.pos];
        if (state.units[sel.unit.id] && state.units[sel.target.id]) {
          const dmg = previewAttack(state, sel.unit.id, sel.target.id);
          ov.damagePreview = {
            tile: sel.target.pos,
            dealt: dmg.dealt,
            received: dmg.counterReceived,
          };
        }
        break;
      }
      case 'capture-staged': {
        const sel = inputState;
        ov.selected = sel.destination;
        ov.moveRange = sel.reachable.map((r) => r.coord);
        ov.movePath = sel.path;
        break;
      }
    }
    return ov;
  }

  function setState(next: InputState, from: string): void {
    inputState = next;
    logTransition(from, next.kind);
    emitter.emit({ type: 'stateChanged', state: emitter.getState(), action: null });
    // Node-only signal for chrome (Cancel chip) — carries just the kind string
    // so the cancel affordance can show/hide without recomputing the overlay.
    // All `kind` changes route through here (hover mutations keep the kind), so
    // this is the single source of truth for "the input node changed".
    emitter.emit({ type: 'inputStateChanged', kind: next.kind });
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
    // On touch there is no true hover: a tap synthesizes a mousemove to the tap
    // point, which would pre-set `hover` to the target and defeat the two-tap
    // confirm (the following click would see hover===target and commit). So on
    // coarse pointers hover is driven ONLY by the explicit two-tap tile-click
    // logic, never by (synthesized) mouse motion.
    if (coarsePointer) return;
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

    // Menus are DOM overlays sitting ABOVE the canvas (menus.ts), so a click on
    // a menu entry is swallowed there and never reaches this canvas handler —
    // the entry's own listener calls chooseAction/chooseBuild. A click that DOES
    // reach here landed on the board, so it's a tile click (which, in a menu
    // state, cancels — see onTileClick).
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

    // The only fork between the two grammars. Everything below `onTileClick`
    // is the original desktop machine, byte for byte.
    if (grammar === 'mobile') onTileClickMobile(tile);
    else onTileClick(tile);
  }

  function chooseAction(label: ActionMenuEntry['label']): void {
    // Validate against the CURRENT action-menu state: ignore stray calls when no
    // menu is open, or for a label that isn't offered / is disabled.
    if (inputState.kind !== 'action-menu') return;
    const entry = inputState.entries.find((e) => e.label === label);
    if (!entry || !entry.enabled) return;
    const unit = inputState.unit;
    if (label === 'Attack') {
      const targets = attackableTargets(emitter.getState(), unit);
      setState(
        { kind: 'attack-targeting', unit, targets, hover: null },
        'action-menu',
      );
    } else if (label === 'Capture') {
      commit({ type: 'CAPTURE', unitId: unit.id });
      setState({ kind: 'idle' }, 'action-menu');
    } else if (label === 'Wait') {
      commit({ type: 'WAIT', unitId: unit.id });
      setState({ kind: 'idle' }, 'action-menu');
    } else if (label === 'Unload') {
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
    } else if (label === 'Dive') {
      commit({ type: 'DIVE', unitId: unit.id });
      setState({ kind: 'idle' }, 'action-menu');
    } else if (label === 'Surface') {
      commit({ type: 'SURFACE', unitId: unit.id });
      setState({ kind: 'idle' }, 'action-menu');
    }
  }

  function chooseBuild(unitType: UnitType): void {
    // Validate against the CURRENT build-menu state + affordability.
    if (inputState.kind !== 'build-menu-open') return;
    const entry = inputState.entries.find((e) => e.unitType === unitType);
    if (!entry || !entry.affordable) return;
    const state = emitter.getState();
    commit({
      type: 'BUILD',
      at: inputState.tile,
      unitType,
      owner: state.currentPlayer,
    });
    setState({ kind: 'idle' }, 'build-menu-open');
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
          const entries = buildMenuEntries(state, state.currentPlayer, tile);
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
        // Two-tap confirm on touch: the first tap on an enemy (or a tap that
        // switches to a different enemy) sets it as the hover target, which
        // renders the existing damage-preview overlay; a second tap on the SAME
        // enemy commits. Mouse (fine pointer) commits on the first click — the
        // hover tooltip was already visible under the cursor. This is the
        // touch-friendly guard against a mis-tap immediately dealing damage.
        if (coarsePointer && inputState.hover?.id !== enemy.id) {
          inputState = { ...inputState, hover: enemy };
          emitter.emit({ type: 'stateChanged', state: emitter.getState(), action: null });
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

  // ─────────────────── Mobile grammar: select → stage → commit ───────────────
  //
  // Only reachable when `opts.grammar === 'mobile'`. See the file header for
  // the tap flow. Invariants worth keeping in mind while reading:
  //   - tap 1 and tap 2 never dispatch. Not once, not for "obvious" cases.
  //   - a commit only ever happens on a re-tap of the staged tile (after the
  //     debounce) or through the explicit `confirmStaged()` button.
  //   - every commit is a sequence of EXISTING actions; the engine is untouched.

  /** Minimum ms between staging and the confirming tap. Below this the second
   *  tap is a double-tap, not a decision, and is dropped. */
  const STAGE_DEBOUNCE_MS = 150;

  function debouncePassed(stagedAt: number): boolean {
    return now() - stagedAt >= STAGE_DEBOUNCE_MS;
  }

  function onTileClickMobile(tile: Coord): void {
    switch (inputState.kind) {
      case 'idle':
      case 'enemy-inspect':
      case 'tile-inspect':
        mobileSelect(tile);
        return;
      case 'unit-selected':
        mobileStage(inputState.unit, inputState.reachable, tile, 'unit-selected');
        return;
      case 'move-previewed': {
        const sel = inputState;
        if (coordEq(tile, sel.destination)) {
          if (!debouncePassed(sel.stagedAt ?? 0)) return;
          commitStagedMove(sel.unit, sel.path, sel.destination);
          return;
        }
        mobileStage(sel.unit, sel.reachable, tile, 'move-previewed');
        return;
      }
      case 'attack-staged': {
        const sel = inputState;
        if (coordEq(tile, sel.target.pos)) {
          if (!debouncePassed(sel.stagedAt)) return;
          commitStagedAttack(sel.unit, sel.target, sel.path);
          return;
        }
        mobileStage(sel.unit, sel.reachable, tile, 'attack-staged');
        return;
      }
      case 'capture-staged': {
        const sel = inputState;
        if (coordEq(tile, sel.destination)) {
          if (!debouncePassed(sel.stagedAt)) return;
          commitStagedCapture(sel.unit, sel.path);
          return;
        }
        mobileStage(sel.unit, sel.reachable, tile, 'capture-staged');
        return;
      }
      case 'action-menu':
      case 'attack-targeting':
      case 'unload-targeting':
      case 'build-menu-open':
        // Menu-ish nodes, only reachable here via `needsOrders`. The desktop
        // handler already does the right thing (cancel / pick a target), so
        // reuse it rather than growing a second copy of that logic.
        onTileClick(tile);
        return;
    }
  }

  /** Tap 1: select an own unit, inspect anything else. Never dispatches. */
  function mobileSelect(tile: Coord): void {
    const state = emitter.getState();
    const occupant = unitAt(state, tile);
    const t = tileAt(state.map, tile);
    // Own, unoccupied factory jumps straight to the build menu — same
    // affordance the desktop grammar gives, and building is the only thing a
    // factory tile is for.
    if (t.terrain === 'factory' && t.owner === state.currentPlayer && !occupant) {
      const entries = buildMenuEntries(state, state.currentPlayer, tile);
      log('render', 'build menu open', { tile });
      setState({ kind: 'build-menu-open', tile, entries }, inputState.kind);
      return;
    }
    if (occupant && occupant.owner === state.currentPlayer) {
      // A spent unit can't be selected (selectUnit would no-op and leave the
      // machine on the previous node); inspect its tile instead.
      if (occupant.hasActed) {
        setState({ kind: 'tile-inspect', tile }, inputState.kind);
        return;
      }
      selectUnit(occupant);
      return;
    }
    if (occupant) {
      // Threat range on by default: the reason to tap an enemy is "what can it
      // hit", so the answer shouldn't hide behind a second tap. The tray's
      // toggle turns it off for players who just want the stat card.
      setState(
        { kind: 'enemy-inspect', unit: occupant, showThreat: true },
        inputState.kind,
      );
      return;
    }
    setState({ kind: 'tile-inspect', tile }, inputState.kind);
  }

  /**
   * Tap 2 (and every re-stage): turn a tap into a staged verb. Never
   * dispatches. A tap with no verb deselects — except on the unit's own tile,
   * which is an explicit request for the orders menu (Wait / Dive / Surface /
   * Unload, and attack-in-place for a direct unit with no enemy tapped).
   */
  function mobileStage(
    unit: Unit,
    reachable: ReachableTile[],
    tile: Coord,
    from: string,
  ): void {
    const state = emitter.getState();
    const occupant = unitAt(state, tile);

    // Another friendly unit: a boardable transport in reach stages the LOAD
    // (committed on the confirming tap); anything else switches selection.
    if (occupant && occupant.owner === unit.owner && occupant.id !== unit.id) {
      const reach = reachable.find((r) => coordEq(r.coord, tile));
      if (reach && reach.path.length > 0 && isLoadable(occupant, unit)) {
        setState(
          {
            kind: 'move-previewed',
            unit,
            reachable,
            destination: tile,
            path: reach.path,
            stagedAt: now(),
          },
          from,
        );
        return;
      }
      mobileSelect(tile);
      return;
    }

    const verb = inferVerb(state, unit, reachable, tile);
    if (verb === 'attack') {
      const target = occupant;
      const firing = target
        ? bestAttackPosition(state, unit, reachable, target)
        : null;
      if (!target || !firing) {
        cancel();
        return;
      }
      setState(
        {
          kind: 'attack-staged',
          unit,
          reachable,
          target,
          firingPos: firing.coord,
          path: firing.path,
          stagedAt: now(),
        },
        from,
      );
      return;
    }
    if (verb === 'capture' || verb === 'move') {
      const reach = reachable.find((r) => coordEq(r.coord, tile));
      if (!reach) {
        cancel();
        return;
      }
      setState(
        verb === 'capture'
          ? {
              kind: 'capture-staged',
              unit,
              reachable,
              destination: tile,
              path: reach.path,
              stagedAt: now(),
            }
          : {
              kind: 'move-previewed',
              unit,
              reachable,
              destination: tile,
              path: reach.path,
              stagedAt: now(),
            },
        from,
      );
      return;
    }
    if (coordEq(tile, unit.pos)) {
      openActionMenuFor(unit, unit.pos);
      return;
    }
    cancel();
  }

  /**
   * Dispatch the MOVE leg of a fused commit and re-read the unit from the
   * fresh state (positions and flags changed under us). An empty path means
   * "act in place" — MOVE with an empty path is illegal, so we skip it.
   * Returns null when the leg failed and the machine was already reset.
   */
  function moveLeg(unit: Unit, path: Coord[]): Unit | null {
    if (path.length > 0) {
      const ok = commit({ type: 'MOVE', unitId: unit.id, path });
      if (!ok) {
        cancel();
        return null;
      }
    }
    const fresh = emitter.getState().units[unit.id];
    if (!fresh) {
      setState({ kind: 'idle' }, inputState.kind);
      return null;
    }
    return fresh;
  }

  /** Commit a staged plain move: MOVE (or LOAD), then close the unit out. */
  function commitStagedMove(unit: Unit, path: Coord[], destination: Coord): void {
    const state = emitter.getState();
    const occupant = unitAt(state, destination);
    if (occupant && occupant.owner === unit.owner && occupant.id !== unit.id) {
      // Staged boarding: LOAD already absorbs the movement.
      commit({ type: 'LOAD', cargoId: unit.id, transportId: occupant.id, path });
      setState({ kind: 'idle' }, inputState.kind);
      return;
    }
    const moved = moveLeg(unit, path);
    if (!moved) return;
    if (needsOrders(emitter.getState(), moved)) {
      openActionMenuFor(moved, moved.pos);
      return;
    }
    // MOVE marks hasMoved but NOT hasActed (see reducer.applyMove), so a bare
    // move would leave the unit hanging around as still-actionable. The mobile
    // grammar treats "I tapped this tile" as the unit's whole turn, so close it
    // out with the same WAIT the action menu's Wait entry dispatches.
    commit({ type: 'WAIT', unitId: moved.id });
    setState({ kind: 'idle' }, inputState.kind);
  }

  /** Commit a staged attack: MOVE (if any) then ATTACK, in one handler. */
  function commitStagedAttack(unit: Unit, target: Unit, path: Coord[]): void {
    const moved = moveLeg(unit, path);
    if (!moved) return;
    if (path.length > 0 && needsOrders(emitter.getState(), moved)) {
      openActionMenuFor(moved, moved.pos);
      return;
    }
    commit({ type: 'ATTACK', attackerId: moved.id, targetId: target.id });
    setState({ kind: 'idle' }, inputState.kind);
  }

  /** Commit a staged capture: MOVE (if any) then CAPTURE, in one handler. */
  function commitStagedCapture(unit: Unit, path: Coord[]): void {
    const moved = moveLeg(unit, path);
    if (!moved) return;
    if (path.length > 0 && needsOrders(emitter.getState(), moved)) {
      openActionMenuFor(moved, moved.pos);
      return;
    }
    commit({ type: 'CAPTURE', unitId: moved.id });
    setState({ kind: 'idle' }, inputState.kind);
  }

  function confirmStaged(): void {
    switch (inputState.kind) {
      case 'move-previewed':
        commitStagedMove(inputState.unit, inputState.path, inputState.destination);
        return;
      case 'attack-staged':
        commitStagedAttack(inputState.unit, inputState.target, inputState.path);
        return;
      case 'capture-staged':
        commitStagedCapture(inputState.unit, inputState.path);
        return;
      case 'build-menu-open': {
        const staged = inputState.staged;
        if (staged !== undefined) chooseBuild(staged);
        return;
      }
      default:
        return;
    }
  }

  function stageBuild(unitType: UnitType): void {
    if (inputState.kind !== 'build-menu-open') return;
    const entry = inputState.entries.find((e) => e.unitType === unitType);
    if (!entry || !entry.affordable) return;
    setState({ ...inputState, staged: unitType }, 'build-menu-open');
  }

  function toggleThreat(): void {
    if (inputState.kind !== 'enemy-inspect') return;
    setState({ ...inputState, showThreat: !inputState.showThreat }, 'enemy-inspect');
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
      const target = state.units[action.targetId];
      const attacker = state.units[action.attackerId];
      if (!target || !attacker) return;
      enqueueAttackEffects(animQueue, state, action.attackerId, action.targetId);
    }
    if (action.type === 'CAPTURE') {
      // Predict whether THIS capture flips the tile so we can flash on commit.
      const u = state.units[action.unitId];
      if (!u) return;
      const tile = state.map[u.pos.y]?.[u.pos.x];
      if (!tile) return;
      const progressGain = Math.floor(u.hp / 10);
      const willFlip = u.captureProgress + progressGain >= 20;
      if (willFlip) {
        animQueue.enqueueCaptureFlash(u.pos, u.owner);
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
    else if (
      e.key === 'Enter' &&
      emitter.getState().winner === null &&
      endTurnAllowed()
    ) {
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
    chooseAction,
    chooseBuild,
    confirmStaged,
    stageBuild,
    toggleThreat,
  };
}

// ─────────────────────────── Helpers ─────────────────────────────────────────

/** The unit a given input node has "selected", or null for states without one
 *  (idle, build menu). Drives the capturable-wash gate: only a canCapture pick
 *  should paint the hint. */
function selectedUnit(s: InputState): Unit | null {
  switch (s.kind) {
    case 'unit-selected':
    case 'move-previewed':
    case 'action-menu':
    case 'attack-targeting':
    // Mobile staged nodes hold our own unit too — the capturable wash should
    // stay lit while a capture/attack is staged. `enemy-inspect` deliberately
    // does NOT count: that unit is theirs, not a selection of ours.
    case 'attack-staged':
    case 'capture-staged':
      return s.unit;
    case 'unload-targeting':
      return s.transport;
    default:
      return null;
  }
}

/**
 * Attack-range overlay = computeAttackArea MINUS the reachable tiles, keyed by
 * coord. The subtraction is the crux of the range-overlay redesign: it
 * guarantees the red fringe never coincides with a blue move tile, so the two
 * fills can't stack into ambiguous mauve. A direct unit is left with just the
 * 1-tile ring beyond its movement; an indirect unit anchors its ring at the
 * current pos (minRange excludes the centre) so a boxed-in artillery keeps its
 * full donut.
 */
function attackFringe(
  state: GameState,
  unit: Unit,
  reachable: ReachableTile[],
): Coord[] {
  const reachKeys = new Set(reachable.map((r) => `${r.coord.x},${r.coord.y}`));
  return computeAttackArea(state, unit, reachable).filter(
    (c) => !reachKeys.has(`${c.x},${c.y}`),
  );
}

/**
 * Every tile `unit` could hit this turn: its attack ring taken over each tile
 * it can move to (indirect units fire only from where they stand, so theirs is
 * anchored at `unit.pos`). Feeds both the desktop attack fringe and the mobile
 * grammar's enemy threat overlay — hence a real export rather than a test-only
 * helper.
 */
export function computeAttackArea(
  state: GameState,
  unit: Unit,
  reachable: ReachableTile[],
): Coord[] {
  const stats = UNITS[unit.type];
  if (stats.maxRange <= 0) return [];
  const firingPositions: Coord[] = stats.indirect
    ? [unit.pos]
    : reachable.map((r) => r.coord);
  const seen = new Set<string>();
  const out: Coord[] = [];
  for (const p of firingPositions) {
    for (let dy = -stats.maxRange; dy <= stats.maxRange; dy++) {
      const absdy = Math.abs(dy);
      const dxMax = stats.maxRange - absdy;
      for (let dx = -dxMax; dx <= dxMax; dx++) {
        const d = absdy + Math.abs(dx);
        if (d < stats.minRange) continue;
        const c = { x: p.x + dx, y: p.y + dy };
        if (!inBounds(state.map, c)) continue;
        const key = `${c.x},${c.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
    }
  }
  return out;
}

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

  // Dive / Surface: submarines toggle their stealth state. Only one of the
  // two labels appears depending on current state. Mutually exclusive with
  // Attack/Capture/Unload since the sub spends its whole action.
  if (!unit.hasActed && unit.type === 'submarine') {
    if (unit.submerged === true) {
      entries.push({ label: 'Surface', enabled: true });
    } else {
      entries.push({ label: 'Dive', enabled: true });
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
export const __test = {
  computeActionMenuEntries,
  isLoadable,
  adjacentUnloadDestinations,
  computeAttackArea,
  attackFringe,
  selectedUnit,
};
export type { PlayerId };
