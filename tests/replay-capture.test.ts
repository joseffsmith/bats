// @vitest-environment jsdom
//
// Live-capture round-trip: the JSONL a browser session accumulates must parse
// with parseLog and re-fold through replay() to the exact state the emitter
// ended on — that equivalence is what makes server-side captures debuggable.

import { describe, expect, it } from 'vitest';
import duelMap from '../src/data/maps/duel.json';
import { loadMap } from '../src/engine/data/loader';
import { parseLog, replay } from '../src/engine/replay';
import { createEmitter } from '../src/renderer/emitter';
import { installReplayCapture } from '../src/renderer/replay-capture';

describe('replay capture', () => {
  it('captured log parses and replays to the emitter final state', () => {
    const initial = loadMap(duelMap);
    const emitter = createEmitter(initial);
    const capture = installReplayCapture(emitter, {
      map: 'duel',
      seed: 0,
      fog: false,
      p0: 'human',
      p1: 'human',
    });

    emitter.dispatch({ type: 'END_TURN' });
    emitter.dispatch({ type: 'END_TURN' });
    emitter.dispatch({ type: 'END_TURN' });

    const parsed = parseLog(capture.exportLog());
    expect(parsed.header.map).toBe('duel');
    expect(parsed.header.client).toBe('browser');
    expect(parsed.actions).toHaveLength(3);

    const replayed = replay(initial, parsed.actions);
    expect(replayed.finalState).toEqual(emitter.getState());
    expect(replayed.skipped).toHaveLength(0);
  });

  it('records pre-action turn/player on each line', () => {
    const initial = loadMap(duelMap);
    const emitter = createEmitter(initial);
    const capture = installReplayCapture(emitter, {
      map: 'duel',
      seed: 0,
      fog: false,
      p0: 'human',
      p1: 'human',
    });
    emitter.dispatch({ type: 'END_TURN' });
    emitter.dispatch({ type: 'END_TURN' });

    const lines = capture
      .exportLog()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; turn?: number; player?: number });
    const actionLines = lines.filter((l) => l.type === 'action');
    expect(actionLines[0]).toMatchObject({ turn: 1, player: 0 });
    expect(actionLines[1]).toMatchObject({ turn: 2, player: 1 });
  });

  it('setState taints the capture and stops recording', () => {
    const initial = loadMap(duelMap);
    const emitter = createEmitter(initial);
    const capture = installReplayCapture(emitter, {
      map: 'duel',
      seed: 0,
      fog: false,
      p0: 'human',
      p1: 'human',
    });
    emitter.dispatch({ type: 'END_TURN' });
    expect(capture.tainted()).toBe(false);

    emitter.setState(loadMap(duelMap));
    expect(capture.tainted()).toBe(true);

    emitter.dispatch({ type: 'END_TURN' });
    const parsed = parseLog(capture.exportLog());
    expect(parsed.actions).toHaveLength(1);
  });

  it('no-op dispatches are not recorded and do not taint', () => {
    const initial = loadMap(duelMap);
    const emitter = createEmitter(initial);
    const capture = installReplayCapture(emitter, {
      map: 'duel',
      seed: 0,
      fog: false,
      p0: 'human',
      p1: 'human',
    });
    // Moving a nonexistent unit is tolerated by the reducer as a no-op.
    emitter.dispatch({ type: 'WAIT', unitId: 'nope' });
    expect(capture.tainted()).toBe(false);
    const parsed = parseLog(capture.exportLog());
    expect(parsed.actions).toHaveLength(0);
  });
});
