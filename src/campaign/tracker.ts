// Mission tracker — the campaign-layer scorekeeper.
//
// It watches the same emitter the renderer does and answers three questions
// the engine deliberately does not: how many units has the player lost, has
// the mission's day limit run out, and how many stars did that performance
// earn. The engine stays untouched — no turn limits, no star bookkeeping, no
// campaign concepts leak into the reducer.
//
// Loss counting is a diff of `state.units` between consecutive events, and it
// only counts across events where `action !== null`. That matters: the mission
// controller injects the scenario with `emitter.setState(...)` (which emits
// `stateChanged` with a null action), and a raw state swap must never look
// like a massacre. The same rule makes replay scrubbing and load-game safe.
//
// Units the player *builds* mid-mission are tracked too: they enter the
// baseline on the event that created them, so losing one costs the no-losses
// star exactly like a starting unit.

import type { GameState, PlayerId, UnitId } from '../engine/core/types';
import type { Emitter, EmitterEvent } from '../renderer/emitter';
import type { Mission, MissionResult } from './types';
import { dayOf, MAX_STARS } from './types';

export type MissionTrackerOptions = {
  emitter: Emitter;
  mission: Mission;
  /** Fired exactly once, the first time the mission resolves. */
  onResult: (result: MissionResult) => void;
  /** Which side the human plays. The campaign always seats them at 0. */
  player?: PlayerId;
};

export type MissionTracker = {
  /** Units the player has lost so far. */
  unitsLost(): number;
  /** Current day, `ceil(turn / 2)`. */
  day(): number;
  /** The result, once resolved; null while the mission is live. */
  result(): MissionResult | null;
  /** Unsubscribe. Safe to call twice; never fires `onResult` afterwards. */
  destroy(): void;
};

/** Ids of `player`'s units in `state`. Loaded cargo counts — it is still alive
 *  and still lost if the transport dies. */
function ownUnitIds(state: GameState, player: PlayerId): Set<UnitId> {
  const ids = new Set<UnitId>();
  for (const u of Object.values(state.units)) {
    if (u.owner === player) ids.add(u.id);
  }
  return ids;
}

/**
 * Stars for a completed mission: one for the win, one for winning by
 * `stars.winByDay`, one for finishing without a loss (when the mission asks
 * for it). Defeat is always zero.
 */
export function computeStars(
  mission: Mission,
  outcome: 'victory' | 'defeat',
  day: number,
  unitsLost: number,
): number {
  if (outcome !== 'victory') return 0;
  let stars = 1;
  if (day <= mission.stars.winByDay) stars += 1;
  if (mission.stars.noUnitLost && unitsLost === 0) stars += 1;
  return Math.min(stars, MAX_STARS);
}

export function createMissionTracker(
  opts: MissionTrackerOptions,
): MissionTracker {
  const { emitter, mission, onResult } = opts;
  const player: PlayerId = opts.player ?? 0;

  let baseline = ownUnitIds(emitter.getState(), player);
  let lost = 0;
  let day = dayOf(emitter.getState().turn);
  let resolved: MissionResult | null = null;
  let destroyed = false;
  let off: (() => void) | null = null;

  function finish(
    outcome: 'victory' | 'defeat',
    reason: 'winner' | 'dayLimit',
    atDay: number,
  ): void {
    if (resolved !== null) return;
    resolved = {
      missionId: mission.id,
      outcome,
      reason,
      day: atDay,
      unitsLost: lost,
      stars: computeStars(mission, outcome, atDay, lost),
    };
    // Stop listening before notifying: the callback usually tears down the
    // match, and we must not score its state changes.
    off?.();
    off = null;
    onResult(resolved);
  }

  function onEvent(event: EmitterEvent): void {
    if (destroyed || resolved !== null) return;
    if (event.type !== 'stateChanged') return;
    const state = event.state;
    day = dayOf(state.turn);

    if (event.action === null) {
      // Scenario injection / load / reset: re-baseline, count nothing.
      baseline = ownUnitIds(state, player);
    } else {
      const now = ownUnitIds(state, player);
      for (const id of baseline) {
        if (!now.has(id)) lost += 1;
      }
      baseline = now;
    }

    if (state.winner !== null) {
      finish(state.winner === player ? 'victory' : 'defeat', 'winner', day);
      return;
    }
    if (day > mission.defeat.dayLimit) {
      finish('defeat', 'dayLimit', day);
    }
  }

  off = emitter.on(onEvent);

  return {
    unitsLost(): number {
      return lost;
    },
    day(): number {
      return day;
    },
    result(): MissionResult | null {
      return resolved;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      off?.();
      off = null;
    },
  };
}
