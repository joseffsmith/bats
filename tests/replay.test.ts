// Phase 6 replay tests.
//
// Two layers:
//   1. Engine layer: replay(initial, actions) is just `reduce`-fold and must
//      produce the same final state byte-for-byte as running the match live.
//   2. Log layer: parseLog can read the JSONL format `runMatch` writes.
//
// We run a tier3 vs tier1 match via the in-process API (no file I/O), then
// re-fold the action stream through the replay engine and confirm structural
// equality with `result.finalState`.

import { describe, expect, it } from 'vitest';
import duelMap from '../src/data/maps/duel.json';
import { loadMap } from '../src/engine/data/loader';
import { runMatch } from '../src/cli/run-match';
import { replay, parseLog } from '../src/engine/replay';

describe('replay', () => {
  it('replaying a tier3 vs tier1 match reproduces the live final state', async () => {
    const result = await runMatch({
      mapName: 'duel',
      maxTurns: 60,
      seed: 7,
      p0: { name: 'tier3' },
      p1: { name: 'tier1' },
      writeLog: false,
    });
    const initial = loadMap(duelMap);
    const actions = result.actions.map((a) => a.action);
    const replayed = replay(initial, actions);
    expect(replayed.finalState).toEqual(result.finalState);
    expect(replayed.skipped.length).toBe(0);
  }, 60_000);

  it('replaying a utility vs random match across several seeds matches live', async () => {
    for (const seed of [1, 2, 3]) {
      const r = await runMatch({
        mapName: 'duel',
        maxTurns: 60,
        seed,
        p0: { name: 'utility' },
        p1: { name: 'random' },
        writeLog: false,
      });
      const initial = loadMap(duelMap);
      const re = replay(initial, r.actions.map((a) => a.action));
      expect(re.finalState).toEqual(r.finalState);
    }
  }, 60_000);

  it('replay yields one intermediate state per action (plus the initial)', async () => {
    const r = await runMatch({
      mapName: 'duel',
      maxTurns: 30,
      seed: 5,
      p0: { name: 'utility' },
      p1: { name: 'random' },
      writeLog: false,
    });
    const initial = loadMap(duelMap);
    const re = replay(initial, r.actions.map((a) => a.action));
    expect(re.states.length).toBe(r.actions.length + 1);
    expect(re.states[0]).toEqual(initial);
    expect(re.states[re.states.length - 1]).toEqual(r.finalState);
  }, 30_000);

  it('parseLog reads the JSONL format produced by runMatch', async () => {
    const r = await runMatch({
      mapName: 'duel',
      maxTurns: 30,
      seed: 11,
      p0: { name: 'tier1' },
      p1: { name: 'random' },
      writeLog: false,
    });
    // Build the JSONL string in-memory the same way runMatch would have.
    const lines = [
      JSON.stringify({ type: 'header', map: 'duel', seed: 11, p0: 'tier1', p1: 'random' }),
      ...r.actions.map((a) => JSON.stringify({ type: 'action', ...a })),
      JSON.stringify({ type: 'summary', turns: r.turns, winner: r.winner }),
    ].join('\n');
    const parsed = parseLog(lines);
    expect(parsed.header.map).toBe('duel');
    expect(parsed.actions.length).toBe(r.actions.length);
    expect(parsed.summary?.winner).toBe(r.winner);
  }, 30_000);

  it('parseLog rejects logs missing a header', () => {
    expect(() => parseLog('{"type":"action","action":{"type":"END_TURN"},"turn":1,"player":0}'))
      .toThrow(/first line is not a header/);
  });

  it('parseLog rejects empty input', () => {
    expect(() => parseLog('')).toThrow(/empty log/);
  });
});
