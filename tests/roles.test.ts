// Phase 5: role assignment tests.
//
// Precedence: defender > capturer > pusher > support > frontline.
// See `src/engine/ai/roles.ts` for the documented rationale.

import { describe, expect, it } from 'vitest';
import './test-helpers';

import { makeState } from './test-helpers';
import { assignRoles, ROLE_MULTIPLIERS } from '../src/engine/ai/roles';
import { computeThreatMap } from '../src/engine/ai/threatMap';
import { generateCandidates } from '../src/engine/ai/candidates';
import { scoreAction } from '../src/engine/ai/utility';
import type { ScoreContext } from '../src/engine/ai/utility';

describe('role assignment', () => {
  it('low-HP unit → support, regardless of other criteria (far from HQ + no threat)', () => {
    // Tank at low HP, far from HQ, no enemies. With no threat to HQ the
    // defender branch never fires; with no nearby capturable for an infantry
    // the capturer branch is skipped (tank isn't infantry anyway). HP < 50
    // sends it to support.
    const state = makeState({
      width: 10,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 9, y: 4 } },
      ],
      units: [{ type: 'tank', owner: 0, pos: { x: 8, y: 3 }, hp: 30 }],
    });
    const t = computeThreatMap(state, 1, 0);
    const roles = assignRoles(state, 0, t);
    expect([...roles.values()][0]).toBe('support');
  });

  it('infantry near unowned city → capturer', () => {
    const state = makeState({
      width: 8,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 2 } },
        { owner: 1, pos: { x: 7, y: 2 } },
      ],
      tiles: [{ pos: { x: 4, y: 2 }, terrain: 'city', owner: null }],
      // Infantry at full HP, 2 tiles from the neutral city → within
      // CAPTURER_PROXIMITY=4. Far from own HQ.
      units: [{ type: 'infantry', owner: 0, pos: { x: 3, y: 2 } }],
    });
    const t = computeThreatMap(state, 1, 0);
    const roles = assignRoles(state, 0, t);
    expect([...roles.values()][0]).toBe('capturer');
  });

  it('tank near own HQ when enemy artillery in range → defender', () => {
    // Enemy artillery directly threatens our HQ tile from distance 2-3.
    // Place artillery at (3,2); HQ at (1,2) — distance 2, within range
    // [2,3]. Tank at (2,2) is within 4 of HQ. Defender role should win
    // over frontline.
    const state = makeState({
      width: 6,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 1, y: 2 } },
        { owner: 1, pos: { x: 5, y: 2 } },
      ],
      units: [
        { type: 'tank', owner: 0, pos: { x: 2, y: 2 } },
        { type: 'artillery', owner: 1, pos: { x: 3, y: 2 } },
      ],
    });
    const t = computeThreatMap(state, 1, 0);
    expect(t[2]![1]!).toBeGreaterThan(0); // HQ tile threatened
    const roles = assignRoles(state, 0, t);
    const tankId = Object.values(state.units).find((u) => u.type === 'tank')!.id;
    expect(roles.get(tankId)).toBe('defender');
  });

  it('everything else → frontline', () => {
    // Healthy tank, no HQ threat, no capturable nearby — falls through to
    // frontline.
    const state = makeState({
      width: 8,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 7, y: 4 } },
      ],
      units: [{ type: 'tank', owner: 0, pos: { x: 4, y: 2 } }],
    });
    const t = computeThreatMap(state, 1, 0);
    const roles = assignRoles(state, 0, t);
    expect([...roles.values()][0]).toBe('frontline');
  });

  it('artillery is always support (even at full HP)', () => {
    const state = makeState({
      width: 8,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 7, y: 4 } },
      ],
      units: [{ type: 'artillery', owner: 0, pos: { x: 4, y: 2 } }],
    });
    const t = computeThreatMap(state, 1, 0);
    const roles = assignRoles(state, 0, t);
    expect([...roles.values()][0]).toBe('support');
  });

  it('healthy infantry on clear path to enemy HQ (no capturable, no HQ threat) → pusher', () => {
    // Infantry in mid-map of a wide board. Own HQ at (0,2), enemy HQ at
    // (15,2) — both are technically capturable, but the infantry sits 7
    // tiles from each (outside CAPTURER_PROXIMITY=4). Defender doesn't
    // apply (HQ not threatened). Capturer doesn't apply (no capturable
    // within 4). Support doesn't apply (HP=100, not artillery). Frontline
    // default would apply for non-infantry — but infantry without a
    // defender/capturer mandate gets `pusher`.
    const state = makeState({
      width: 16,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 2 } },
        { owner: 1, pos: { x: 15, y: 2 } },
      ],
      // Infantry at (7,2) — distance 7 to own HQ, 8 to enemy HQ.
      units: [{ type: 'infantry', owner: 0, pos: { x: 7, y: 2 }, hp: 100 }],
    });
    const t = computeThreatMap(state, 1, 0);
    const roles = assignRoles(state, 0, t);
    expect([...roles.values()][0]).toBe('pusher');
  });

  it('low-HP infantry (no capturable, no HQ threat) → support, NOT pusher', () => {
    // Same as above but HP < SUPPORT_HP_THRESHOLD. Should fall through to
    // support so it retreats, not march into enemy fire.
    const state = makeState({
      width: 16,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 2 } },
        { owner: 1, pos: { x: 15, y: 2 } },
      ],
      units: [{ type: 'infantry', owner: 0, pos: { x: 7, y: 2 }, hp: 30 }],
    });
    const t = computeThreatMap(state, 1, 0);
    const roles = assignRoles(state, 0, t);
    expect([...roles.values()][0]).toBe('support');
  });

  it('pusher infantry receives objective bonus toward enemy HQ', () => {
    // Infantry mid-board, plain terrain everywhere, far from any capturable
    // (own HQ at 0, enemy HQ at 15 → distance 7+ from each, outside
    // CAPTURER_PROXIMITY=4) → assigned pusher. Compare the score of a move
    // STRICTLY toward the enemy HQ vs the score of staying put: the toward-
    // HQ move must score strictly higher.
    //
    // We add an enemy infantry parked next to the enemy HQ so that the
    // engine doesn't end the match by "rout" win as soon as we apply an
    // action (which would change the win-state and thus the scoring path).
    const state = makeState({
      width: 16,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 2 } },
        { owner: 1, pos: { x: 15, y: 2 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 7, y: 2 }, hp: 100 },
        { type: 'infantry', owner: 1, pos: { x: 14, y: 2 }, hp: 100 },
      ],
    });
    const tm = computeThreatMap(state, 1, 0);
    const roles = assignRoles(state, 0, tm);
    const unit = Object.values(state.units).find((u) => u.owner === 0)!;
    expect(roles.get(unit.id)).toBe('pusher');

    const sctx: ScoreContext = {
      weights: {
        damageDealt: 1,
        capture: 1,
        counterRisk: 1,
        futureThreat: 1,
        positional: 1,
        objective: 1,
      },
      planOpts: {
        useThreatMap: true,
        useRoles: true,
        roleMultipliers: ROLE_MULTIPLIERS,
        buildPolicy: {},
        fog: false,
      },
      enemyReach: new Map(),
      threatMap: tm,
      valueMap: null,
      role: 'pusher',
      frontlineTarget: null,
    };
    // Apply role multipliers to the weights, mirroring planUtilityTurn's
    // pre-multiplication.
    const m = ROLE_MULTIPLIERS.pusher;
    sctx.weights = {
      damageDealt: sctx.weights.damageDealt * m.damageDealt,
      capture: sctx.weights.capture * m.capture,
      counterRisk: sctx.weights.counterRisk * m.counterRisk,
      futureThreat: sctx.weights.futureThreat * m.futureThreat,
      positional: sctx.weights.positional * m.positional,
      objective: sctx.weights.objective * m.objective,
    };

    const enemyHq = state.players[1].hq;
    const distBefore = Math.abs(unit.pos.x - enemyHq.x) + Math.abs(unit.pos.y - enemyHq.y);
    let towardHqScore = -Infinity;
    let stayScore = -Infinity;
    let nCandidates = 0;
    let nTowardHq = 0;
    for (const c of generateCandidates(state, unit)) {
      nCandidates += 1;
      const dest = c.destination;
      const distAfter = Math.abs(dest.x - enemyHq.x) + Math.abs(dest.y - enemyHq.y);
      const s = scoreAction(state, c, unit, sctx);
      if (dest.x === unit.pos.x && dest.y === unit.pos.y) {
        if (s > stayScore) stayScore = s;
      } else if (distAfter < distBefore) {
        // Strictly closer to enemy HQ → pusher should reward this.
        nTowardHq += 1;
        if (s > towardHqScore) towardHqScore = s;
      }
    }
    expect(nCandidates).toBeGreaterThan(0);
    expect(nTowardHq).toBeGreaterThan(0);
    expect(towardHqScore).toBeGreaterThan(stayScore);
  });
});
