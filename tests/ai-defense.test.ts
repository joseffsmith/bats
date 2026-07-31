// Home-defense behaviour. Regression for the "cowardly defender" bug found
// via a live-site match report: an enemy infantry mid-capture on an owned
// factory near the HQ flipped nearby units into the defender role, whose old
// scoring (futureThreat ×3, objective = step-toward-own-HQ) made them flee
// the blanketed home zone entirely — wounded units parked in far corners
// while the factory fell. Defenders must contest intruders, and ALL units
// get a raw bonus for attacking an enemy standing on owned property.

import { describe, expect, it } from 'vitest';
import './test-helpers';
import { makeState } from './test-helpers';
import { personaAI } from '../src/engine/ai/personas';
import { nearestHomeIntruder } from '../src/engine/ai/utility';
import { createRng } from '../src/engine/core/rng';
import type { GameState } from '../src/engine/core/types';

/** Enemy infantry mid-capture (10/20) on p1's factory two tiles from p1 HQ. */
function besiegedFactoryState(p1Units: Parameters<typeof makeState>[0]['units']): GameState {
  const state = makeState({
    width: 10,
    height: 5,
    defaultTerrain: 'plain',
    hqs: [
      { owner: 0, pos: { x: 0, y: 2 } },
      { owner: 1, pos: { x: 9, y: 2 } },
    ],
    tiles: [{ pos: { x: 7, y: 2 }, terrain: 'factory', owner: 1 }],
    units: [{ type: 'infantry', owner: 0, pos: { x: 7, y: 2 }, hp: 100 }, ...(p1Units ?? [])],
    funds: { 0: 0, 1: 0 },
  });
  state.units['u1']!.captureProgress = 10;
  state.currentPlayer = 1;
  return state;
}

describe('home defense', () => {
  it('wounded defenders still contest a capturer instead of fleeing', () => {
    // The original repro: 30hp tank two tiles away, 25hp infantry nearby.
    // Pre-fix, both retreated across the map and the capture ran unopposed.
    const state = besiegedFactoryState([
      { type: 'tank', owner: 1, pos: { x: 5, y: 2 }, hp: 30 },
      { type: 'infantry', owner: 1, pos: { x: 6, y: 3 }, hp: 25 },
    ]);
    const actions = personaAI('balanced').takeTurn({ state, player: 1, rng: createRng(1) });
    const attacks = actions.filter((a) => a.type === 'ATTACK');
    expect(attacks.length).toBeGreaterThan(0);
    expect(attacks.every((a) => a.type === 'ATTACK' && a.targetId === 'u1')).toBe(true);
  });

  it('healthy defender attacks the capturer (all personas)', () => {
    for (const persona of ['aggressor', 'turtle', 'economist', 'balanced']) {
      const state = besiegedFactoryState([
        { type: 'tank', owner: 1, pos: { x: 5, y: 2 }, hp: 100 },
      ]);
      const actions = personaAI(persona).takeTurn({ state, player: 1, rng: createRng(1) });
      expect(
        actions.some((a) => a.type === 'ATTACK' && a.targetId === 'u1'),
        `${persona} should attack the capturer`,
      ).toBe(true);
    }
  });

  it('nearestHomeIntruder prefers the capturer with most progress', () => {
    const state = makeState({
      width: 10,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 2 } },
        { owner: 1, pos: { x: 9, y: 2 } },
      ],
      tiles: [
        { pos: { x: 7, y: 2 }, terrain: 'factory', owner: 1 },
        { pos: { x: 6, y: 0 }, terrain: 'city', owner: 1 },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 7, y: 2 }, hp: 100 },
        { type: 'infantry', owner: 0, pos: { x: 6, y: 0 }, hp: 100 },
        // Closer to the HQ than either capturer, but not capturing.
        { type: 'recon', owner: 0, pos: { x: 8, y: 3 }, hp: 100 },
      ],
      funds: { 0: 0, 1: 0 },
    });
    state.units['u1']!.captureProgress = 15;
    state.units['u2']!.captureProgress = 5;
    const intruder = nearestHomeIntruder(state, 1);
    expect(intruder?.pos).toEqual({ x: 7, y: 2 });
  });

  it('nearestHomeIntruder falls back to near-HQ enemies, then null', () => {
    const state = makeState({
      width: 10,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 2 } },
        { owner: 1, pos: { x: 9, y: 2 } },
      ],
      units: [
        { type: 'recon', owner: 0, pos: { x: 8, y: 4 }, hp: 100 },
        { type: 'tank', owner: 0, pos: { x: 1, y: 2 }, hp: 100 },
      ],
      funds: { 0: 0, 1: 0 },
    });
    const intruder = nearestHomeIntruder(state, 1);
    expect(intruder?.pos).toEqual({ x: 8, y: 4 });
    // Far tank only → no intruder at all.
    delete state.units[intruder!.id];
    expect(nearestHomeIntruder(state, 1)).toBeNull();
  });
});
