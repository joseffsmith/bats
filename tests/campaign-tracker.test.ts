// Mission tracker: loss counting, star arithmetic, and the campaign-layer
// day limit. The engine knows none of this — it is all computed by watching
// the same emitter the renderer watches.

import { describe, expect, it } from 'vitest';
import campaignJson from '../src/data/campaign.json';
import c1Map from '../src/data/maps/c1_first_strike.json';
import { createInitialState } from '../src/engine/core/initial-state';
import { loadMap } from '../src/engine/data/loader';
import { setLogEnabled } from '../src/engine/core/logger';
import type { GameState } from '../src/engine/core/types';
import { createEmitter } from '../src/renderer/emitter';
import { loadCampaign } from '../src/campaign/loader';
import { computeStars, createMissionTracker } from '../src/campaign/tracker';
import type { Mission, MissionResult } from '../src/campaign/types';

setLogEnabled('engine', false);

function makeMission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'test_mission',
    n: 1,
    title: 'Test',
    map: 'c1_first_strike',
    opponent: { persona: 'turtle', name: 'Warden Kessel', flavor: 'Digs in.' },
    objective: 'Win.',
    intro: ['Fight.'],
    fog: false,
    hints: [],
    stars: { winByDay: 3, noUnitLost: true },
    defeat: { dayLimit: 8 },
    ...over,
  };
}

/** A 5×5 board: P0 has two soldiers, P1 has a tank next to the wounded one. */
function skirmishState(): GameState {
  return createInitialState({
    width: 5,
    height: 5,
    hqs: [
      { owner: 0, pos: { x: 0, y: 4 } },
      { owner: 1, pos: { x: 4, y: 0 } },
    ],
    units: [
      { type: 'infantry', owner: 0, pos: { x: 2, y: 2 }, hp: 10 },
      { type: 'infantry', owner: 0, pos: { x: 0, y: 3 } },
      { type: 'tank', owner: 1, pos: { x: 2, y: 1 } },
      { type: 'infantry', owner: 1, pos: { x: 4, y: 1 } },
    ],
  });
}

/** P0's tank is one swing away from routing P1's last unit. */
function winnableState(): GameState {
  return createInitialState({
    width: 5,
    height: 5,
    hqs: [
      { owner: 0, pos: { x: 0, y: 4 } },
      { owner: 1, pos: { x: 4, y: 0 } },
    ],
    units: [
      { type: 'tank', owner: 0, pos: { x: 2, y: 2 } },
      { type: 'infantry', owner: 1, pos: { x: 2, y: 1 }, hp: 10 },
    ],
  });
}

function track(state: GameState, mission: Mission) {
  const emitter = createEmitter(state);
  const results: MissionResult[] = [];
  const tracker = createMissionTracker({
    emitter,
    mission,
    onResult: (r) => results.push(r),
  });
  return { emitter, tracker, results };
}

/** Pass `n` plies (END_TURN each) without anyone dying. */
function endTurns(emitter: ReturnType<typeof createEmitter>, n: number): void {
  for (let i = 0; i < n; i++) emitter.dispatch({ type: 'END_TURN' });
}

describe('mission tracker — loss counting', () => {
  it('counts a unit the opponent destroys', () => {
    const { emitter, tracker } = track(skirmishState(), makeMission());
    emitter.dispatch({ type: 'END_TURN' }); // hand the board to P1
    expect(tracker.unitsLost()).toBe(0);
    emitter.dispatch({ type: 'ATTACK', attackerId: 'u3', targetId: 'u1' });
    expect(emitter.getState().units.u1).toBeUndefined();
    expect(tracker.unitsLost()).toBe(1);
  });

  it('ignores a wholesale setState — scenario injection is not a massacre', () => {
    const { emitter, tracker } = track(skirmishState(), makeMission());
    const injected = skirmishState();
    delete injected.units.u1;
    emitter.setState(injected);
    expect(tracker.unitsLost()).toBe(0);
    // And the re-baseline sticks: later real actions do not retro-count it.
    emitter.dispatch({ type: 'END_TURN' });
    expect(tracker.unitsLost()).toBe(0);
  });

  it('does not count the opponent’s losses', () => {
    const { emitter, tracker } = track(winnableState(), makeMission());
    emitter.dispatch({ type: 'ATTACK', attackerId: 'u1', targetId: 'u2' });
    expect(tracker.unitsLost()).toBe(0);
  });

  it('counts units built during the mission', () => {
    const state = createInitialState({
      width: 5,
      height: 5,
      hqs: [
        { owner: 0, pos: { x: 0, y: 4 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 4 }, terrain: 'factory', owner: 0 }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'tank', owner: 1, pos: { x: 1, y: 3 } },
        { type: 'tank', owner: 1, pos: { x: 2, y: 4 } },
      ],
      funds: { 0: 5000 },
    });
    const { emitter, tracker } = track(state, makeMission());
    emitter.dispatch({
      type: 'BUILD',
      at: { x: 1, y: 4 },
      unitType: 'infantry',
      owner: 0,
    });
    const built = Object.values(emitter.getState().units).find(
      (u) => u.owner === 0 && u.pos.x === 1 && u.pos.y === 4,
    );
    expect(built).toBeDefined();
    expect(tracker.unitsLost()).toBe(0);

    emitter.dispatch({ type: 'END_TURN' });
    // A recruit standing on its factory has three defence stars, so it takes
    // both tanks to put it down.
    emitter.dispatch({ type: 'ATTACK', attackerId: 'u2', targetId: built!.id });
    emitter.dispatch({ type: 'ATTACK', attackerId: 'u3', targetId: built!.id });
    // The fresh recruit died: a built unit costs the no-losses star just like a
    // starting one.
    expect(emitter.getState().units[built!.id]).toBeUndefined();
    expect(tracker.unitsLost()).toBe(1);
  });
});

describe('mission tracker — stars', () => {
  it('computeStars covers the matrix', () => {
    const m = makeMission({ stars: { winByDay: 3, noUnitLost: true } });
    expect(computeStars(m, 'victory', 2, 0)).toBe(3);
    expect(computeStars(m, 'victory', 3, 0)).toBe(3); // boundary is inclusive
    expect(computeStars(m, 'victory', 4, 0)).toBe(2); // slow but clean
    expect(computeStars(m, 'victory', 2, 1)).toBe(2); // fast but bloody
    expect(computeStars(m, 'victory', 9, 3)).toBe(1); // a win is a win
    expect(computeStars(m, 'defeat', 1, 0)).toBe(0);

    // A mission that does not ask for a clean sheet caps at two.
    const lenient = makeMission({ stars: { winByDay: 3, noUnitLost: false } });
    expect(computeStars(lenient, 'victory', 1, 0)).toBe(2);
    expect(computeStars(lenient, 'victory', 9, 0)).toBe(1);
  });

  it('awards three stars for a fast, clean win', () => {
    const { emitter, results } = track(
      winnableState(),
      makeMission({ stars: { winByDay: 1, noUnitLost: true } }),
    );
    emitter.dispatch({ type: 'ATTACK', attackerId: 'u1', targetId: 'u2' });
    expect(emitter.getState().winner).toBe(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      missionId: 'test_mission',
      outcome: 'victory',
      reason: 'winner',
      day: 1,
      unitsLost: 0,
      stars: 3,
    });
  });

  it('drops the speed star when the win comes late', () => {
    const { emitter, results } = track(
      winnableState(),
      makeMission({ stars: { winByDay: 1, noUnitLost: true }, defeat: { dayLimit: 20 } }),
    );
    endTurns(emitter, 4); // turn 5 → day 3
    emitter.dispatch({ type: 'ATTACK', attackerId: 'u1', targetId: 'u2' });
    expect(results[0]?.day).toBe(3);
    expect(results[0]?.stars).toBe(2);
  });

  it('reports a defeat when the opponent wins', () => {
    const state = createInitialState({
      width: 5,
      height: 5,
      hqs: [
        { owner: 0, pos: { x: 0, y: 4 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 2, y: 2 }, hp: 10 },
        { type: 'tank', owner: 1, pos: { x: 2, y: 1 } },
      ],
    });
    const { emitter, results } = track(state, makeMission());
    emitter.dispatch({ type: 'END_TURN' });
    emitter.dispatch({ type: 'ATTACK', attackerId: 'u2', targetId: 'u1' });
    expect(emitter.getState().winner).toBe(1);
    expect(results[0]).toMatchObject({
      outcome: 'defeat',
      reason: 'winner',
      unitsLost: 1,
      stars: 0,
    });
  });
});

describe('mission tracker — day limit', () => {
  it('declares defeat once the day limit is passed', () => {
    const { emitter, tracker, results } = track(
      skirmishState(),
      makeMission({ defeat: { dayLimit: 3 } }),
    );
    endTurns(emitter, 5); // turn 6 → day 3: still inside the limit
    expect(tracker.day()).toBe(3);
    expect(results).toHaveLength(0);

    emitter.dispatch({ type: 'END_TURN' }); // turn 7 → day 4
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      outcome: 'defeat',
      reason: 'dayLimit',
      day: 4,
      stars: 0,
    });
  });

  it('fires the result exactly once and stops scoring afterwards', () => {
    const { emitter, tracker, results } = track(
      skirmishState(),
      makeMission({ defeat: { dayLimit: 1 } }),
    );
    endTurns(emitter, 6);
    expect(results).toHaveLength(1);
    expect(tracker.result()).toBe(results[0]);
    // Later carnage does not add to the count or fire again.
    emitter.dispatch({ type: 'ATTACK', attackerId: 'u1', targetId: 'u3' });
    expect(results).toHaveLength(1);
  });

  it('a win on the last legal day is still a win', () => {
    const { emitter, results } = track(
      winnableState(),
      makeMission({ stars: { winByDay: 1, noUnitLost: true }, defeat: { dayLimit: 2 } }),
    );
    endTurns(emitter, 2); // turn 3 → day 2
    emitter.dispatch({ type: 'ATTACK', attackerId: 'u1', targetId: 'u2' });
    expect(results[0]).toMatchObject({ outcome: 'victory', day: 2, stars: 2 });
  });

  it('destroy stops the tracker', () => {
    const { emitter, tracker, results } = track(
      skirmishState(),
      makeMission({ defeat: { dayLimit: 1 } }),
    );
    tracker.destroy();
    tracker.destroy(); // idempotent
    endTurns(emitter, 6);
    expect(results).toHaveLength(0);
    expect(tracker.result()).toBeNull();
  });
});

describe('mission tracker — against the shipped mission 1', () => {
  it('scores a three-star run on the real board', () => {
    const mission = loadCampaign(campaignJson)[0]!;
    const { emitter, tracker, results } = track(loadMap(c1Map), mission);
    expect(tracker.day()).toBe(1);

    // Day 1: the left tank kills the wounded scout outright; the right tank
    // reaches the picket in the trees, where two stars of forest cover mean it
    // survives the first round.
    emitter.dispatch({
      type: 'MOVE',
      unitId: 'u1',
      path: [
        { x: 2, y: 6 },
        { x: 2, y: 5 },
        { x: 3, y: 5 },
      ],
    });
    emitter.dispatch({ type: 'ATTACK', attackerId: 'u1', targetId: 'u4' });
    expect(emitter.getState().units.u4).toBeUndefined();

    emitter.dispatch({
      type: 'MOVE',
      unitId: 'u2',
      path: [
        { x: 4, y: 6 },
        { x: 4, y: 5 },
        { x: 4, y: 4 },
        { x: 3, y: 4 },
        { x: 3, y: 3 },
        { x: 2, y: 3 },
      ],
    });
    emitter.dispatch({ type: 'ATTACK', attackerId: 'u2', targetId: 'u5' });
    expect(emitter.getState().units.u5!.hp).toBeLessThan(100);
    expect(emitter.getState().winner).toBeNull();

    emitter.dispatch({ type: 'END_TURN' }); // opponent's day 1
    emitter.dispatch({ type: 'END_TURN' }); // → day 2, back to the player
    expect(tracker.day()).toBe(2);

    emitter.dispatch({ type: 'ATTACK', attackerId: 'u2', targetId: 'u5' });

    // Rout: P1 has nothing left, on day 2 of a mission that wants day 3.
    expect(emitter.getState().winner).toBe(0);
    expect(results[0]).toMatchObject({
      missionId: mission.id,
      outcome: 'victory',
      reason: 'winner',
      day: 2,
      unitsLost: 0,
      stars: 3,
    });
  });
});
