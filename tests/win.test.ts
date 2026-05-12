import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';

describe('win conditions', () => {
  it('HQ capture sets winner and rejects further actions', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        // Both players need at least one unit to avoid the rout shortcut.
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        // Player 1 infantry sitting on player 0's HQ at near-full progress.
        { type: 'infantry', owner: 1, pos: { x: 0, y: 0 } },
      ],
    });
    const p1Inf = Object.values(s.units).find((u) => u.owner === 1)!;
    // Player 0's turn; we need it to be player 1's turn to legally capture.
    let st = reduce(s, { type: 'END_TURN' });
    st = reduce(st, { type: 'CAPTURE', unitId: p1Inf.id });
    expect(st.units[p1Inf.id]!.captureProgress).toBe(10);
    // End turn back to player 1, capture again to flip.
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'CAPTURE', unitId: p1Inf.id });
    expect(st.map[0]![0]!.owner).toBe(1);
    expect(st.winner).toBe(1);

    // Any subsequent action is rejected.
    const after = reduce(st, { type: 'END_TURN' });
    expect(after).toBe(st);
  });

  it('rout: a player with zero units loses', () => {
    const s = makeState({
      width: 3,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        { type: 'tank', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 1, y: 0 }, hp: 20 },
      ],
    });
    const a = Object.values(s.units).find((u) => u.type === 'tank')!;
    const t = Object.values(s.units).find((u) => u.type === 'infantry')!;
    const next = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: t.id });
    expect(next.units[t.id]).toBeUndefined();
    expect(next.winner).toBe(0);
  });
});
