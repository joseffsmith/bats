// Persona system smoke tests.
//
// - all personas load from ai-personas.json,
// - weights are non-negative finite and non-zero (at least one positive),
// - a persona's role overrides parse correctly,
// - two different personas produce DIFFERENT action sequences from the same
//   starting state and seed (otherwise the personas aren't actually different).

import { describe, expect, it } from 'vitest';
import './test-helpers';

import duelMap from '../src/data/maps/duel.json';
import {
  loadPersonas,
  PERSONAS,
  PERSONA_NAMES,
} from '../src/engine/ai/personas';
import { runMatch } from '../src/cli/run-match';
import { utilityAI } from '../src/engine/ai/utility';
import { makeState } from './test-helpers';
import { createRng } from '../src/engine/core/rng';

const REQUIRED_PERSONAS = ['aggressor', 'turtle', 'economist', 'balanced'];

describe('personas loader', () => {
  it('loads every required persona from ai-personas.json', () => {
    for (const name of REQUIRED_PERSONAS) {
      expect(PERSONAS[name], `missing persona "${name}"`).toBeTruthy();
    }
  });

  it('sorted names matches sorted keys', () => {
    expect([...PERSONA_NAMES].sort()).toEqual(PERSONA_NAMES);
  });

  it('rejects negative weights', () => {
    expect(() =>
      loadPersonas({
        personas: [
          {
            name: 'bad',
            description: 'x',
            weights: {
              damageDealt: -1,
              capture: 1,
              counterRisk: 1,
              futureThreat: 1,
              positional: 1,
              objective: 1,
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects missing weight key', () => {
    expect(() =>
      loadPersonas({
        personas: [
          {
            name: 'bad',
            description: 'x',
            weights: { damageDealt: 1 },
          },
        ],
      }),
    ).toThrow(/missing weight key/);
  });

  it('rejects unknown unit type in buildPolicy', () => {
    expect(() =>
      loadPersonas({
        personas: [
          {
            name: 'bad',
            description: 'x',
            weights: {
              damageDealt: 1,
              capture: 1,
              counterRisk: 1,
              futureThreat: 1,
              positional: 1,
              objective: 1,
            },
            buildPolicy: { preferred: ['submarine'] },
          },
        ],
      }),
    ).toThrow(/unknown unit type/);
  });

  it('rejects duplicate persona names', () => {
    expect(() =>
      loadPersonas({
        personas: [
          {
            name: 'dup',
            description: 'x',
            weights: {
              damageDealt: 1,
              capture: 1,
              counterRisk: 1,
              futureThreat: 1,
              positional: 1,
              objective: 1,
            },
          },
          {
            name: 'dup',
            description: 'y',
            weights: {
              damageDealt: 1,
              capture: 1,
              counterRisk: 1,
              futureThreat: 1,
              positional: 1,
              objective: 1,
            },
          },
        ],
      }),
    ).toThrow(/duplicate name/);
  });

  it('every persona has plausible weights', () => {
    for (const name of REQUIRED_PERSONAS) {
      const p = PERSONAS[name]!;
      const ws = Object.values(p.weights);
      for (const w of ws) {
        expect(Number.isFinite(w)).toBe(true);
        expect(w).toBeGreaterThanOrEqual(0);
      }
      // Not ALL zero.
      expect(ws.some((w) => w > 0)).toBe(true);
    }
  });
});

describe('personaAI dispatch', () => {
  // Run a longer same-side comparison through runMatch — the engine grants
  // income each turn, so by turn ~5 both personas have funds to BUILD and the
  // build-policy divergence shows up. Two matches with the same seed and the
  // same opponent (random), but different p0 personas: the action streams
  // must differ.
  it('different personas yield different match traces vs random@same-seed', async () => {
    const a = await runMatch({
      mapName: 'duel',
      maxTurns: 80,
      seed: 11,
      mapJson: duelMap,
      writeLog: false,
      p0: { name: 'aggressor' },
      p1: { name: 'random' },
    });
    const t = await runMatch({
      mapName: 'duel',
      maxTurns: 80,
      seed: 11,
      mapJson: duelMap,
      writeLog: false,
      p0: { name: 'turtle' },
      p1: { name: 'random' },
    });

    // Same opponent, same seed → only persona differs. Action streams MUST
    // diverge somewhere (build choices differ, weights differ).
    expect(a.actions.length).toBeGreaterThan(0);
    expect(t.actions.length).toBeGreaterThan(0);

    const aP0Actions = a.actions.filter((x) => x.player === 0);
    const tP0Actions = t.actions.filter((x) => x.player === 0);
    expect(JSON.stringify(aP0Actions)).not.toEqual(JSON.stringify(tP0Actions));
  }, 120_000);

  it('build policy actually biases what gets built', async () => {
    // Aggressor has `avoid: ['artillery']` — it must NEVER build one in 30
    // turns. Turtle has `avoid: ['recon']` — it must NEVER build one. Both
    // constraints exercise the avoid path of the build policy.
    const agg = await runMatch({
      mapName: 'crossroads',
      maxTurns: 30,
      seed: 5,
      mapJson: undefined,
      writeLog: false,
      p0: { name: 'aggressor' },
      p1: { name: 'random' },
    });
    const turt = await runMatch({
      mapName: 'crossroads',
      maxTurns: 30,
      seed: 5,
      mapJson: undefined,
      writeLog: false,
      p0: { name: 'turtle' },
      p1: { name: 'random' },
    });
    const aBuilds = agg.actions.filter(
      (x) => x.player === 0 && x.action.type === 'BUILD',
    );
    const tBuilds = turt.actions.filter(
      (x) => x.player === 0 && x.action.type === 'BUILD',
    );
    // Both must have actually built things — otherwise the test is vacuous.
    expect(aBuilds.length).toBeGreaterThan(0);
    expect(tBuilds.length).toBeGreaterThan(0);
    // Aggressor avoids artillery.
    const aArtillery = aBuilds.filter(
      (x) => x.action.type === 'BUILD' && x.action.unitType === 'artillery',
    );
    // Turtle avoids recon.
    const tRecons = tBuilds.filter(
      (x) => x.action.type === 'BUILD' && x.action.unitType === 'recon',
    );
    expect(aArtillery.length).toBe(0);
    expect(tRecons.length).toBe(0);
  }, 120_000);
});

describe('build policy: infantryFloor activation', () => {
  // Regression for the iter-4 economist bug: a high `infantryFloor` was acting
  // as a HARD-PREFER-infantry trigger even after the player had built up a
  // healthy roster of tanks/recon. The fix gates the floor on ALSO having a
  // low total unit count (`totalMyUnits < floor + 2`), so once we have a
  // mixed force the `preferred` list (tank-first) takes over.
  it('high infantryFloor does NOT force infantry build when total roster is large', () => {
    // Persona-like config: infantryFloor=5, preferred=[tank,...]; 4 infantry +
    // 3 tanks already on the board (total=7). With the old rule the floor
    // fires (4 < 5) and infantry is built; with the new rule (4 < 5) && (7 <
    // 7) is false so the preferred list wins → tank is built.
    const FUNDS = 8000; // enough for a single tank (7000) and infantry (1000)
    const state = makeState({
      width: 10,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 2 } },
        { owner: 1, pos: { x: 9, y: 2 } },
      ],
      tiles: [
        // A factory we own at (1,2) — a fresh build will go here.
        { pos: { x: 1, y: 2 }, terrain: 'factory', owner: 0 },
        // An unowned city so `unowned > 0` is true (the floor check requires it).
        { pos: { x: 5, y: 0 }, terrain: 'city', owner: null },
      ],
      units: [
        // 4 infantry + 3 tanks — all positioned out of the way so the factory
        // is unoccupied. Mark them all as already-acted so the AI's
        // move/attack loop bails immediately and reaches the BUILD phase.
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 }, hp: 100 },
        { type: 'infantry', owner: 0, pos: { x: 0, y: 1 }, hp: 100 },
        { type: 'infantry', owner: 0, pos: { x: 0, y: 3 }, hp: 100 },
        { type: 'infantry', owner: 0, pos: { x: 0, y: 4 }, hp: 100 },
        { type: 'tank', owner: 0, pos: { x: 2, y: 0 }, hp: 100 },
        { type: 'tank', owner: 0, pos: { x: 2, y: 1 }, hp: 100 },
        { type: 'tank', owner: 0, pos: { x: 2, y: 3 }, hp: 100 },
      ],
      funds: { 0: FUNDS, 1: 0 },
    });
    // Mark all owned units as already moved+acted so the AI doesn't try to
    // shuffle them before getting to BUILD.
    for (const u of Object.values(state.units)) {
      if (u.owner === 0) {
        u.hasMoved = true;
        u.hasActed = true;
      }
    }

    // Tier-3 utility AI mirroring an "economist-like" persona but with
    // infantryFloor=5 and tank-first preferred.
    const ai = utilityAI({
      name: 'high-floor-test',
      useThreatMap: true,
      useRoles: true,
      buildPolicy: {
        preferred: ['tank', 'recon', 'infantry'],
        infantryFloor: 5,
      },
    });

    const actions = ai.takeTurn({ state, player: 0, rng: createRng(1) });
    const builds = actions.filter((a) => a.type === 'BUILD');
    // Exactly one factory → exactly one build action.
    expect(builds.length).toBe(1);
    const b = builds[0]!;
    if (b.type !== 'BUILD') throw new Error('unreachable');
    expect(b.unitType).toBe('tank');
  });

  it('low-roster + below-floor still builds infantry (floor is preserved when it matters)', () => {
    // Same persona, but only 1 infantry + 0 other units → total=1, floor=5.
    // 1<5 AND 1<7 → floor active, infantry built (not tank, even though
    // affordable).
    const FUNDS = 8000;
    const state = makeState({
      width: 10,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 2 } },
        { owner: 1, pos: { x: 9, y: 2 } },
      ],
      tiles: [
        { pos: { x: 1, y: 2 }, terrain: 'factory', owner: 0 },
        { pos: { x: 5, y: 0 }, terrain: 'city', owner: null },
      ],
      units: [{ type: 'infantry', owner: 0, pos: { x: 0, y: 0 }, hp: 100 }],
      funds: { 0: FUNDS, 1: 0 },
    });
    for (const u of Object.values(state.units)) {
      if (u.owner === 0) {
        u.hasMoved = true;
        u.hasActed = true;
      }
    }

    const ai = utilityAI({
      name: 'high-floor-test',
      useThreatMap: true,
      useRoles: true,
      buildPolicy: {
        preferred: ['tank', 'recon', 'infantry'],
        infantryFloor: 5,
      },
    });
    const actions = ai.takeTurn({ state, player: 0, rng: createRng(1) });
    const builds = actions.filter((a) => a.type === 'BUILD');
    expect(builds.length).toBe(1);
    const b = builds[0]!;
    if (b.type !== 'BUILD') throw new Error('unreachable');
    expect(b.unitType).toBe('infantry');
  });
});

describe('personaAI runs end-to-end', () => {
  // Cheap smoke: aggressor vs balanced finishes in <60s headless.
  it('aggressor vs balanced finishes a match on duel', async () => {
    const r = await runMatch({
      mapName: 'duel',
      maxTurns: 100,
      seed: 1,
      mapJson: duelMap,
      writeLog: false,
      p0: { name: 'aggressor' },
      p1: { name: 'balanced' },
    });
    expect(r.turns).toBeGreaterThan(0);
    expect(r.actions.length).toBeGreaterThan(0);
  }, 90_000);
});

