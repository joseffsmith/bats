// Random AI tests.
//
// Property tests: across 50 turns on both shipped maps the random AI must
//   - always terminate its plan with END_TURN
//   - never emit an illegal action

import { describe, expect, it } from 'vitest';
import './test-helpers';

import duelMap from '../src/data/maps/duel.json';
import crossroadsMap from '../src/data/maps/crossroads.json';
import { loadMap } from '../src/engine/data/loader';
import { reduce } from '../src/engine/core/reducer';
import { isLegalAction } from '../src/engine/core/validators';
import { createRng } from '../src/engine/core/rng';
import { randomAI } from '../src/engine/ai/random';
import type { GameState } from '../src/engine/core/types';

function play(state: GameState, turnsToPlay: number): { state: GameState; illegals: number } {
  const ai = randomAI({ name: 'random' });
  const rng0 = createRng(101);
  const rng1 = createRng(202);
  let illegals = 0;
  for (let i = 0; i < turnsToPlay; i++) {
    if (state.winner !== null) break;
    const rng = state.currentPlayer === 0 ? rng0 : rng1;
    const plan = ai.takeTurn({ state, player: state.currentPlayer, rng });
    expect(plan.length).toBeGreaterThan(0);
    expect(plan[plan.length - 1]!.type).toBe('END_TURN');
    for (const action of plan) {
      const legality = isLegalAction(state, action);
      if (!legality.legal) {
        illegals += 1;
        continue;
      }
      state = reduce(state, action);
      if (state.winner !== null) break;
    }
  }
  return { state, illegals };
}

describe('random AI', () => {
  it('always terminates with END_TURN (duel)', () => {
    const state = loadMap(duelMap);
    const { illegals } = play(state, 50);
    expect(illegals).toBe(0);
  });

  it('never emits an illegal action (duel)', () => {
    const state = loadMap(duelMap);
    const { illegals } = play(state, 50);
    expect(illegals).toBe(0);
  });

  it('never emits an illegal action (crossroads)', () => {
    const state = loadMap(crossroadsMap);
    const { illegals } = play(state, 50);
    expect(illegals).toBe(0);
  });

  it('produces at least one END_TURN per planned turn', () => {
    const state = loadMap(duelMap);
    const ai = randomAI({ name: 'random' });
    const rng = createRng(1);
    const plan = ai.takeTurn({ state, player: 0, rng });
    expect(plan.filter((a) => a.type === 'END_TURN').length).toBe(1);
    expect(plan[plan.length - 1]!.type).toBe('END_TURN');
  });
});
