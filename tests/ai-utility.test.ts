// Utility AI behavioural tests.
//
// Each scenario constructs a small handcrafted state, asks the utility AI
// for a turn plan, and asserts a specific tactical decision was made.

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';

import { loadMap } from '../src/engine/data/loader';
import duelMap from '../src/data/maps/duel.json';
import { reduce } from '../src/engine/core/reducer';
import { isLegalAction } from '../src/engine/core/validators';
import { createRng } from '../src/engine/core/rng';
import { utilityAI } from '../src/engine/ai/utility';
import type { Action, GameState } from '../src/engine/core/types';

function aiPlan(state: GameState, seed = 1): Action[] {
  const ai = utilityAI({ name: 'utility' });
  const rng = createRng(seed);
  return ai.takeTurn({ state, player: state.currentPlayer, rng });
}

describe('utility AI: legality', () => {
  it('never emits an illegal action over a sequence of turns', () => {
    let state = loadMap(duelMap);
    for (let i = 0; i < 40; i++) {
      if (state.winner !== null) break;
      const plan = aiPlan(state);
      expect(plan[plan.length - 1]!.type).toBe('END_TURN');
      for (const a of plan) {
        const legality = isLegalAction(state, a);
        expect(legality.legal).toBe(true);
        state = reduce(state, a);
        if (state.winner !== null) break;
      }
    }
  });
});

describe('utility AI: tactical preferences', () => {
  it('prefers a guaranteed kill over WAIT', () => {
    // P0 tank at (1,1), P1 infantry at (2,1) with 10 HP — one tank shot kills.
    // Tank should ATTACK (with or without an intervening MOVE), not WAIT.
    const state = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 5, y: 1 } },
      ],
      units: [
        { type: 'tank', owner: 0, pos: { x: 1, y: 1 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 1 }, hp: 10 },
      ],
    });
    const plan = aiPlan(state);
    const hasAttack = plan.some(
      (a) => a.type === 'ATTACK' && a.attackerId.length > 0,
    );
    expect(hasAttack).toBe(true);
  });

  it('captures an unguarded neutral city when an infantry is adjacent', () => {
    // P0 infantry on a neutral city tile, no enemy in attack range.
    // The "stay put + CAPTURE" candidate should win.
    const state = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 5, y: 1 } },
      ],
      tiles: [{ pos: { x: 2, y: 1 }, terrain: 'city', owner: null }],
      units: [{ type: 'infantry', owner: 0, pos: { x: 2, y: 1 } }],
    });
    const plan = aiPlan(state);
    const cap = plan.find((a) => a.type === 'CAPTURE');
    expect(cap).toBeDefined();
  });

  it('does not move artillery and attack in the same turn', () => {
    // P0 artillery at (4,1), P1 tank at (6,1) — 2 tiles away (in range).
    // The artillery should stay put and ATTACK; legality enforces this but
    // we also want the AI to never even propose a (MOVE, ATTACK) candidate
    // for an indirect unit. The plan must not contain a MOVE for the
    // artillery followed by an ATTACK before END_TURN.
    const state = makeState({
      width: 9,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 8, y: 1 } },
      ],
      units: [
        { type: 'artillery', owner: 0, pos: { x: 4, y: 1 } },
        { type: 'tank', owner: 1, pos: { x: 6, y: 1 } },
      ],
    });
    const plan = aiPlan(state);
    // Find every artillery action sequence up to END_TURN.
    let lastMoveIdx = -1;
    let attackIdx = -1;
    for (let i = 0; i < plan.length; i++) {
      const a = plan[i]!;
      if (a.type === 'MOVE' && a.unitId.length > 0) lastMoveIdx = i;
      if (a.type === 'ATTACK') attackIdx = i;
    }
    // If an ATTACK occurred, no MOVE preceded it in the same turn.
    if (attackIdx >= 0 && lastMoveIdx >= 0) {
      expect(lastMoveIdx).toBeGreaterThan(attackIdx);
    }
    // And the AI should be attacking on this turn (the tank is in range).
    expect(plan.some((a) => a.type === 'ATTACK')).toBe(true);
  });

  it('avoids stepping into 1-shot range of an enemy tank when counter-risk is severe', () => {
    // P0 recon at (3,1) hp 100. P1 tank at (5,1).
    // Recon vs tank counter would be brutal — recon should NOT step adjacent
    // to the tank.
    //
    // Specifically: among the recon's move destinations, (4,1) is adjacent to
    // the tank. The AI should not commit a MOVE that places the recon at (4,1).
    const state = makeState({
      width: 9,
      height: 3,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 8, y: 1 } },
      ],
      units: [
        { type: 'recon', owner: 0, pos: { x: 3, y: 1 } },
        { type: 'tank', owner: 1, pos: { x: 5, y: 1 } },
      ],
    });
    const plan = aiPlan(state);
    // Walk through actions and assert the recon's final tile (if it moved at
    // all) is not adjacent to (5,1).
    let st = state;
    for (const a of plan) {
      if (!isLegalAction(st, a).legal) continue;
      st = reduce(st, a);
      if (st.winner !== null) break;
    }
    const reconAfter = Object.values(st.units).find(
      (u) => u.owner === 0 && u.type === 'recon',
    );
    if (reconAfter) {
      const dist = Math.abs(reconAfter.pos.x - 5) + Math.abs(reconAfter.pos.y - 1);
      expect(dist).toBeGreaterThan(1);
    }
  });
});
