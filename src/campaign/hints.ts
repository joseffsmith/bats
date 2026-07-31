// Hint runner — walks a mission's hint script in strict order.
//
// The teaching problem this solves: a beginner needs "tap your tank" to be
// on screen until they tap a tank, then "tap a highlighted tile" until they
// move, and never both at once. So the runner keeps a single cursor into the
// hint list and only ever displays `hints[cursor]`:
//
//   • the current hint appears when its `show` trigger fires (or immediately,
//     if `show.on === 'immediate'` — that includes becoming current after its
//     predecessor cleared);
//   • it disappears when its `clear` trigger fires, and the cursor advances;
//   • the event that cleared hint i is re-offered to hint i+1's `show`, so a
//     script can hand off on a single event ("clear on MOVE" → "show on MOVE").
//     At most one show and one clear happen per event, so the cursor can never
//     run away and skip a hint the player never saw.
//
// Fused sequences: the input layer dispatches MOVE and then ATTACK back to
// back, which arrives here as two consecutive `stateChanged` events. Because
// matching is per-event and the cursor is monotonic, a hint keyed to MOVE and
// the next one keyed to ATTACK both land correctly — no coalescing needed.
//
// The runner never touches the DOM. `present(text)` renders; `present(null)`
// hides. That keeps this module testable in node and lets the screens phase
// decide what a hint looks like.

import type { GameState, PlayerId } from '../engine/core/types';
import { otherPlayer } from '../engine/core/types';
import type { Emitter, EmitterEvent } from '../renderer/emitter';
import type { HintSpec, Trigger } from './types';
import { dayOf } from './types';

export type HintRunnerOptions = {
  emitter: Emitter;
  hints: ReadonlyArray<HintSpec>;
  /** Called with the hint text to show, or null to hide. */
  present: (text: string | null) => void;
  /** Whose actions the script is coaching. The AI dispatches through the same
   *  emitter, so `action` triggers ignore everyone else's moves — otherwise the
   *  opponent's attack during its turn would tick the script forward. Defaults
   *  to 0, the seat the campaign always gives the player. */
  player?: PlayerId;
};

export type HintRunner = {
  /** Index of the hint currently being waited on / displayed. Equals
   *  `hints.length` once the script is exhausted. Diagnostics + tests. */
  index(): number;
  /** Id of the hint on screen, or null when nothing is showing. */
  activeId(): string | null;
  /** Unsubscribe and hide any visible hint. Safe to call twice. */
  destroy(): void;
};

/** Who just acted. Every action except END_TURN leaves the board with its
 *  author still to move; END_TURN hands it over, so the actor is the player who
 *  just left. */
function actorOf(state: GameState, actionType: string): PlayerId {
  return actionType === 'END_TURN'
    ? otherPlayer(state.currentPlayer)
    : state.currentPlayer;
}

/** Does `event` satisfy `trigger`? `immediate` is deliberately never matched
 *  here — it fires when the hint becomes current, not on an event. */
function matches(trigger: Trigger, event: EmitterEvent, player: PlayerId): boolean {
  switch (trigger.on) {
    case 'immediate':
      return false;
    case 'input':
      return event.type === 'inputStateChanged' && event.kind === trigger.kind;
    case 'action':
      // `action` is null when the reducer no-op'd (an illegal tap) or when the
      // state was swapped wholesale via setState — neither is a player action.
      return (
        event.type === 'stateChanged' &&
        event.action !== null &&
        event.action.type === trigger.type &&
        actorOf(event.state, event.action.type) === player
      );
    case 'turn':
      // `>=` rather than `===` so a hint whose day passed while an earlier hint
      // was still on screen still gets its turn instead of being stranded.
      return event.type === 'stateChanged' && dayOf(event.state.turn) >= trigger.day;
    default:
      return false;
  }
}

export function createHintRunner(opts: HintRunnerOptions): HintRunner {
  const { emitter, hints, present } = opts;
  const player: PlayerId = opts.player ?? 0;
  let cursor = 0;
  let showing = false;
  let destroyed = false;

  function current(): HintSpec | undefined {
    return hints[cursor];
  }

  /** Show the current hint if its trigger is `immediate`. Called when a hint
   *  becomes current (start of the script, and after each clear). */
  function showIfImmediate(): void {
    const hint = current();
    if (!hint || showing) return;
    if (hint.show.on === 'immediate') {
      showing = true;
      present(hint.text);
    }
  }

  function onEvent(event: EmitterEvent): void {
    if (destroyed) return;
    const hint = current();
    if (!hint) return;

    if (showing) {
      if (!matches(hint.clear, event, player)) return;
      showing = false;
      present(null);
      cursor += 1;
      // Hand the same event to the next hint: scripts routinely clear on the
      // action that the following hint reacts to.
      const next = current();
      if (next) {
        if (next.show.on === 'immediate' || matches(next.show, event, player)) {
          showing = true;
          present(next.text);
        }
      }
      return;
    }

    if (matches(hint.show, event, player)) {
      showing = true;
      present(hint.text);
    }
  }

  const off = emitter.on(onEvent);
  showIfImmediate();

  return {
    index(): number {
      return cursor;
    },
    activeId(): string | null {
      if (!showing) return null;
      return current()?.id ?? null;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      off();
      if (showing) {
        showing = false;
        present(null);
      }
    },
  };
}
