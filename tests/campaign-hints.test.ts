// Hint runner sequencing, driven through the real emitter + real reducer.
//
// Nothing here fakes the event stream: every `stateChanged` comes from an
// actual `emitter.dispatch`, so the tests exercise the same fused
// MOVE-then-ATTACK pair the input layer produces when a player commits a move
// and swings in one gesture.

import { beforeEach, describe, expect, it } from 'vitest';
import c1Map from '../src/data/maps/c1_first_strike.json';
import campaignJson from '../src/data/campaign.json';
import { loadMap } from '../src/engine/data/loader';
import { createEmitter } from '../src/renderer/emitter';
import type { Emitter } from '../src/renderer/emitter';
import { createHintRunner } from '../src/campaign/hints';
import { loadCampaign } from '../src/campaign/loader';
import type { HintSpec } from '../src/campaign/types';
import { setLogEnabled } from '../src/engine/core/logger';

setLogEnabled('engine', false);

// c1_first_strike unit ids, assigned by loadMap in JSON order.
const P0_TANK_LEFT = 'u1'; // (2,7)
const P0_TANK_RIGHT = 'u2'; // (4,7)
const P1_SCOUT = 'u4'; // (3,4), hp 60 — one tank round kills it
const P1_PICKET = 'u5'; // (2,2), in forest

function freshEmitter(): Emitter {
  return createEmitter(loadMap(c1Map));
}

/** Records every `present` call so a test can assert the whole sequence. */
function recorder(): { calls: (string | null)[]; present: (t: string | null) => void } {
  const calls: (string | null)[] = [];
  return { calls, present: (t) => calls.push(t) };
}

/** Walk the left tank up to (3,5) and shell the scout at (3,4) — two separate
 *  dispatches, exactly as the input layer fuses them. */
function moveAndAttack(emitter: Emitter): void {
  emitter.dispatch({
    type: 'MOVE',
    unitId: P0_TANK_LEFT,
    path: [
      { x: 2, y: 6 },
      { x: 2, y: 5 },
      { x: 3, y: 5 },
    ],
  });
  emitter.dispatch({ type: 'ATTACK', attackerId: P0_TANK_LEFT, targetId: P1_SCOUT });
}

const hint = (
  id: string,
  show: HintSpec['show'],
  clear: HintSpec['clear'],
  text = id,
): HintSpec => ({ id, show, clear, text });

describe('hint runner — basics', () => {
  let emitter: Emitter;

  beforeEach(() => {
    emitter = freshEmitter();
  });

  it('shows an immediate hint the moment it is created', () => {
    const { calls, present } = recorder();
    const runner = createHintRunner({
      emitter,
      present,
      hints: [hint('a', { on: 'immediate' }, { on: 'action', type: 'MOVE' }, 'Tap your tank.')],
    });
    expect(calls).toEqual(['Tap your tank.']);
    expect(runner.activeId()).toBe('a');
    expect(runner.index()).toBe(0);
  });

  it('clears on the action it names and advances the cursor', () => {
    const { calls, present } = recorder();
    const runner = createHintRunner({
      emitter,
      present,
      hints: [
        hint('a', { on: 'immediate' }, { on: 'action', type: 'MOVE' }),
        hint('b', { on: 'input', kind: 'action-menu' }, { on: 'action', type: 'ATTACK' }),
      ],
    });
    moveAndAttack(emitter);
    // 'b' waits on an input event, so the ATTACK must not have shown it.
    expect(calls).toEqual(['a', null]);
    expect(runner.index()).toBe(1);
    expect(runner.activeId()).toBeNull();

    emitter.emit({ type: 'inputStateChanged', kind: 'action-menu' });
    expect(calls).toEqual(['a', null, 'b']);
  });

  it('hands the clearing event straight to the next hint', () => {
    const { calls, present } = recorder();
    createHintRunner({
      emitter,
      present,
      hints: [
        hint('a', { on: 'immediate' }, { on: 'action', type: 'MOVE' }),
        hint('b', { on: 'action', type: 'MOVE' }, { on: 'action', type: 'ATTACK' }),
        hint('c', { on: 'action', type: 'ATTACK' }, { on: 'action', type: 'END_TURN' }),
      ],
    });
    moveAndAttack(emitter);
    expect(calls).toEqual(['a', null, 'b', null, 'c']);
  });

  it('tolerates a fused MOVE → ATTACK arriving as two consecutive events', () => {
    const { calls, present } = recorder();
    const runner = createHintRunner({
      emitter,
      present,
      hints: [
        hint('move', { on: 'immediate' }, { on: 'action', type: 'MOVE' }),
        hint('attack', { on: 'action', type: 'MOVE' }, { on: 'action', type: 'ATTACK' }),
        hint('after', { on: 'action', type: 'ATTACK' }, { on: 'turn', day: 9 }),
      ],
    });
    moveAndAttack(emitter);
    // The scout died, so the sequence really did run through the reducer.
    expect(emitter.getState().units[P1_SCOUT]).toBeUndefined();
    expect(calls).toEqual(['move', null, 'attack', null, 'after']);
    expect(runner.index()).toBe(2);
    expect(runner.activeId()).toBe('after');
  });

  it('never skips a hint: one show and one clear per event at most', () => {
    const { calls, present } = recorder();
    const runner = createHintRunner({
      emitter,
      present,
      hints: [
        hint('a', { on: 'immediate' }, { on: 'action', type: 'MOVE' }),
        // 'b' both shows and would clear on MOVE — it must still be displayed.
        hint('b', { on: 'action', type: 'MOVE' }, { on: 'action', type: 'MOVE' }),
      ],
    });
    emitter.dispatch({
      type: 'MOVE',
      unitId: P0_TANK_LEFT,
      path: [{ x: 2, y: 6 }],
    });
    expect(calls).toEqual(['a', null, 'b']);
    expect(runner.activeId()).toBe('b');
  });

  it('ignores dispatches the reducer refused', () => {
    const { calls, present } = recorder();
    createHintRunner({
      emitter,
      present,
      hints: [hint('a', { on: 'immediate' }, { on: 'action', type: 'MOVE' })],
    });
    // Illegal: no such unit. The emitter still fires stateChanged, with a null
    // action — a hint must not treat that as a move.
    emitter.dispatch({ type: 'MOVE', unitId: 'nope', path: [{ x: 1, y: 1 }] });
    // Illegal: destination equals origin.
    emitter.dispatch({ type: 'MOVE', unitId: P0_TANK_LEFT, path: [{ x: 2, y: 7 }] });
    expect(calls).toEqual(['a']);
  });

  it('ignores a wholesale setState (scenario injection)', () => {
    const { calls, present } = recorder();
    createHintRunner({
      emitter,
      present,
      hints: [hint('a', { on: 'immediate' }, { on: 'action', type: 'MOVE' })],
    });
    emitter.setState(loadMap(c1Map));
    expect(calls).toEqual(['a']);
  });

  it('only follows the coached player: the opponent’s actions do not advance it', () => {
    const { calls, present } = recorder();
    const runner = createHintRunner({
      emitter,
      present,
      hints: [
        hint('a', { on: 'immediate' }, { on: 'action', type: 'END_TURN' }),
        hint('b', { on: 'action', type: 'MOVE' }, { on: 'action', type: 'ATTACK' }),
      ],
    });
    emitter.dispatch({ type: 'END_TURN' });
    expect(calls).toEqual(['a', null]);
    expect(emitter.getState().currentPlayer).toBe(1);

    // The AI now moves through the same emitter. 'b' waits on the *player's*
    // MOVE, so this one must be ignored.
    emitter.dispatch({ type: 'MOVE', unitId: P1_PICKET, path: [{ x: 2, y: 3 }] });
    expect(calls).toEqual(['a', null]);
    expect(runner.activeId()).toBeNull();

    emitter.dispatch({ type: 'END_TURN' });
    emitter.dispatch({
      type: 'MOVE',
      unitId: P0_TANK_RIGHT,
      path: [{ x: 4, y: 6 }],
    });
    expect(calls).toEqual(['a', null, 'b']);
  });

  it('fires a turn hint once the day counter reaches it', () => {
    const { calls, present } = recorder();
    createHintRunner({
      emitter,
      present,
      hints: [
        hint('a', { on: 'immediate' }, { on: 'turn', day: 2 }),
        hint('b', { on: 'turn', day: 2 }, { on: 'turn', day: 4 }),
      ],
    });
    emitter.dispatch({ type: 'END_TURN' }); // turn 2 — still day 1
    expect(calls).toEqual(['a']);
    emitter.dispatch({ type: 'END_TURN' }); // turn 3 — day 2
    expect(calls).toEqual(['a', null, 'b']);
  });

  it('destroy hides the visible hint and unsubscribes', () => {
    const { calls, present } = recorder();
    const runner = createHintRunner({
      emitter,
      present,
      hints: [hint('a', { on: 'immediate' }, { on: 'action', type: 'MOVE' })],
    });
    runner.destroy();
    expect(calls).toEqual(['a', null]);
    runner.destroy(); // idempotent
    moveAndAttack(emitter);
    expect(calls).toEqual(['a', null]);
  });

  it('runs off the end of the script without complaint', () => {
    const { calls, present } = recorder();
    const runner = createHintRunner({
      emitter,
      present,
      hints: [hint('a', { on: 'immediate' }, { on: 'action', type: 'MOVE' })],
    });
    moveAndAttack(emitter);
    emitter.dispatch({ type: 'END_TURN' });
    expect(calls).toEqual(['a', null]);
    expect(runner.index()).toBe(1);
    expect(runner.activeId()).toBeNull();
  });

  it('an empty hint list is a no-op', () => {
    const { calls, present } = recorder();
    const runner = createHintRunner({ emitter, present, hints: [] });
    moveAndAttack(emitter);
    expect(calls).toEqual([]);
    expect(runner.index()).toBe(0);
    runner.destroy();
  });
});

describe('hint runner — mission 1 script', () => {
  it('walks the shipped mission-1 hints in order as the player plays', () => {
    const mission = loadCampaign(campaignJson)[0]!;
    const emitter = freshEmitter();
    const { calls, present } = recorder();
    const runner = createHintRunner({ emitter, present, hints: mission.hints });

    const textOf = (id: string): string =>
      mission.hints.find((h) => h.id === id)!.text;

    // Mission start: "tap one of your tanks".
    expect(calls).toEqual([textOf('h1_select')]);

    // Selecting a unit clears it and asks for the move.
    emitter.emit({ type: 'inputStateChanged', kind: 'unit-selected' });
    expect(calls.at(-1)).toBe(textOf('h2_stage_move'));

    // Commit the move, then swing — the fused pair the input layer emits.
    moveAndAttack(emitter);
    expect(calls.at(-1)).toBe(textOf('h4_end_turn'));
    expect(runner.index()).toBe(3);

    // End the turn: the opponent's day begins.
    emitter.dispatch({ type: 'END_TURN' });
    expect(calls.at(-1)).toBe(textOf('h5_their_turn'));

    // The opponent plays and ends their turn; day 2 arrives.
    emitter.dispatch({ type: 'END_TURN' });
    expect(calls.at(-1)).toBe(textOf('h6_finish'));

    // Every text presented came from the mission, in list order, and each hint
    // was cleared before the next appeared.
    const shown = calls.filter((c): c is string => c !== null);
    const order = mission.hints.map((h) => h.text);
    expect(shown).toEqual(order.slice(0, shown.length));
    for (let i = 1; i < calls.length; i += 2) expect(calls[i]).toBeNull();

    runner.destroy();
  });
});
