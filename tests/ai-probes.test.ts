// Scripted probe-opponent tests.
//
// Probes are yardsticks, not contenders — we don't assert anything about how
// well they play. What we DO assert is the AI contract, because a probe that
// desyncs or emits garbage would silently corrupt every gate run built on it:
//   - deterministic: same state + same seed ⇒ byte-identical action log
//   - always terminates with END_TURN
//   - never throws and never emits an illegal action across several turns

import { describe, expect, it } from 'vitest';
import './test-helpers';

import duelMap from '../src/data/maps/duel.json';
import { loadMap } from '../src/engine/data/loader';
import { reduce } from '../src/engine/core/reducer';
import { isLegalAction } from '../src/engine/core/validators';
import { createRng } from '../src/engine/core/rng';
import { randomAI } from '../src/engine/ai/random';
import { probeAI, PROBE_NAMES, isProbeName } from '../src/engine/ai/probes';
import type { Action, GameState } from '../src/engine/core/types';

function freshDuel(): GameState {
  return loadMap(duelMap);
}

describe('probe registry', () => {
  it('exposes exactly the three probes, sorted', () => {
    expect([...PROBE_NAMES]).toEqual(['probe-camper', 'probe-kiter', 'probe-rush']);
  });

  it('isProbeName agrees with PROBE_NAMES', () => {
    for (const n of PROBE_NAMES) expect(isProbeName(n)).toBe(true);
    expect(isProbeName('balanced')).toBe(false);
    expect(isProbeName('probe-nope')).toBe(false);
  });

  it('probeAI reports the requested name and rejects unknown ones', () => {
    for (const n of PROBE_NAMES) expect(probeAI(n).name).toBe(n);
    expect(() => probeAI('probe-nope')).toThrow(/unknown probe/);
  });
});

describe.each([...PROBE_NAMES])('probe %s', (probeName) => {
  it('is deterministic: same seed on a cloned state gives an identical plan', () => {
    const a = freshDuel();
    const b = structuredClone(a);
    const planA = probeAI(probeName).takeTurn({ state: a, player: 0, rng: createRng(99) });
    const planB = probeAI(probeName).takeTurn({ state: b, player: 0, rng: createRng(99) });
    expect(planA).toEqual(planB);
    expect(planA.length).toBeGreaterThan(0);
  });

  it('does not mutate the state it is handed', () => {
    const state = freshDuel();
    const before = structuredClone(state);
    probeAI(probeName).takeTurn({ state, player: 0, rng: createRng(3) });
    expect(state).toEqual(before);
  });

  it('always terminates with exactly one END_TURN', () => {
    const state = freshDuel();
    const plan = probeAI(probeName).takeTurn({ state, player: 0, rng: createRng(7) });
    expect(plan[plan.length - 1]!.type).toBe('END_TURN');
    expect(plan.filter((a) => a.type === 'END_TURN').length).toBe(1);
  });

  it('bails with END_TURN when it is not its turn', () => {
    const state = freshDuel();
    const plan = probeAI(probeName).takeTurn({ state, player: 1, rng: createRng(7) });
    expect(plan).toEqual<Action[]>([{ type: 'END_TURN' }]);
  });

  it('plays 3 turns against random on duel without throwing or acting illegally', () => {
    let state = freshDuel();
    const probe = probeAI(probeName);
    const opponent = randomAI({ name: 'random' });
    const rngs = [createRng(11), createRng(22)] as const;

    let illegals = 0;
    // 3 full turns for the probe ⇒ 6 half-turns overall.
    for (let i = 0; i < 6 && state.winner === null; i++) {
      const player = state.currentPlayer;
      const ai = player === 0 ? probe : opponent;
      const plan = ai.takeTurn({ state, player, rng: rngs[player] });
      expect(plan[plan.length - 1]!.type).toBe('END_TURN');
      for (const action of plan) {
        if (!isLegalAction(state, action).legal) {
          illegals += 1;
          continue;
        }
        state = reduce(state, action);
        if (state.winner !== null) break;
      }
    }
    expect(illegals).toBe(0);
    expect(state.turn).toBeGreaterThan(1);
  });
});

describe('probe behaviour sanity', () => {
  it('probe-rush builds infantry and nothing else', () => {
    // Give p0 enough cash that a tank/artillery would be affordable if the
    // build order allowed it.
    const state = freshDuel();
    state.players[0].funds = 50_000;
    const plan = probeAI('probe-rush').takeTurn({ state, player: 0, rng: createRng(1) });
    const builds = plan.filter((a) => a.type === 'BUILD');
    expect(builds.length).toBeGreaterThan(0);
    for (const b of builds) {
      expect(b.type === 'BUILD' && b.unitType).toBe('infantry');
    }
  });

  it('probe-camper never moves a unit outside the HQ bubble', () => {
    let state = freshDuel();
    const camper = probeAI('probe-camper');
    const rng = createRng(5);
    const hq = state.players[0].hq;
    // Camper takes several turns in a row (opponent just passes) — if it ever
    // wandered, distance-from-HQ would grow past the radius.
    for (let t = 0; t < 4; t++) {
      const plan = camper.takeTurn({ state, player: 0, rng });
      for (const action of plan) {
        if (!isLegalAction(state, action).legal) continue;
        state = reduce(state, action);
      }
      // Opponent passes.
      state = reduce(state, { type: 'END_TURN' });
    }
    for (const u of Object.values(state.units)) {
      if (u.owner !== 0) continue;
      const d = Math.abs(u.pos.x - hq.x) + Math.abs(u.pos.y - hq.y);
      expect(d).toBeLessThanOrEqual(3);
    }
  });
});
