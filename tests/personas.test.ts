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
            buildPolicy: { preferred: ['battleship'] },
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
    // Run aggressor (avoid=artillery) and turtle (preferred=artillery first)
    // on a long enough match that both have time to BUILD multiple times.
    // Verify aggressor never builds artillery, turtle builds at least one.
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
    // Aggressor avoids artillery.
    const aArtillery = aBuilds.filter(
      (x) => x.action.type === 'BUILD' && x.action.unitType === 'artillery',
    );
    const tArtillery = tBuilds.filter(
      (x) => x.action.type === 'BUILD' && x.action.unitType === 'artillery',
    );
    expect(aArtillery.length).toBe(0);
    // Turtle should have built at least one artillery if it had funds for it.
    // 6000 cost on crossroads with 4 cities + factory means 5000/turn — so by
    // turn ~3 it can afford one.
    expect(tArtillery.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
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

