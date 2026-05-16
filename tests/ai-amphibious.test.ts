// AI amphibious operations: DIVE/SURFACE, LOAD/UNLOAD enumeration + scoring.
//
// Acceptance gates from plans/amphibious-ai.md: the candidate generator must
// yield the new action types and the utility AI must pick them in the
// representative tactical setups below. The tournament-level acceptance
// (armada / island_hop stalemate rates) is covered separately by the
// round-robin regression in AI_TUNING.md round 7.

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';
import { createRng } from '../src/engine/core/rng';
import { generateCandidates } from '../src/engine/ai/candidates';
import { utilityAI } from '../src/engine/ai/utility';
import { personaAI } from '../src/engine/ai/personas';
import { isLegalAction } from '../src/engine/core/validators';
import { loadMap } from '../src/engine/data/loader';
import armadaMap from '../src/data/maps/armada.json';
import type { Action, GameState } from '../src/engine/core/types';

function aiPlan(state: GameState, seed = 1): Action[] {
  const ai = utilityAI({ name: 'utility', useThreatMap: true, useRoles: true });
  const rng = createRng(seed);
  return ai.takeTurn({ state, player: state.currentPlayer, rng });
}

function candidateActions(state: GameState, unitId: string): string[] {
  const u = state.units[unitId]!;
  const out: string[] = [];
  for (const c of generateCandidates(state, u)) {
    out.push(c.followUp.type);
  }
  return out;
}

// ─────────────────────────── Layer 1: DIVE / SURFACE ─────────────────────────

describe('AI amphibious: DIVE / SURFACE', () => {
  it('yields DIVE candidate for a surfaced sub adjacent to an enemy battleship', () => {
    const s = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 5, y: 1 } },
      ],
      // Make HQs reachable land; leave the rest sea.
      tiles: [
        { pos: { x: 0, y: 1 }, terrain: 'hq', owner: 0 },
        { pos: { x: 5, y: 1 }, terrain: 'hq', owner: 1 },
      ],
      units: [
        { type: 'submarine', owner: 0, pos: { x: 2, y: 1 } },
        { type: 'battleship', owner: 1, pos: { x: 3, y: 1 } },
      ],
    });
    const subId = Object.values(s.units).find((u) => u.type === 'submarine')!.id;
    const types = candidateActions(s, subId);
    expect(types).toContain('DIVE');
  });

  it('yields SURFACE candidate for a submerged sub', () => {
    let s = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 5, y: 1 } },
      ],
      units: [
        { type: 'submarine', owner: 0, pos: { x: 2, y: 1 } },
        { type: 'battleship', owner: 1, pos: { x: 3, y: 1 } },
      ],
    });
    const subId = Object.values(s.units).find((u) => u.type === 'submarine')!.id;
    s = reduce(s, { type: 'DIVE', unitId: subId });
    // Reset hasActed manually so we can re-enumerate candidates this turn.
    s = { ...s, units: { ...s.units, [subId]: { ...s.units[subId]!, hasActed: false, hasMoved: false } } };
    const types = candidateActions(s, subId);
    expect(types).toContain('SURFACE');
  });

  it('utility AI dives a surfaced sub that is threatened by an unreachable artillery', () => {
    // Sea strip down column 3 (the only water on the map); enemy artillery at
    // (5,2) on plain — in range 2 of the sub at (3,2). The sub cannot reach
    // any tile adjacent to the artillery (all land), so ATTACK isn't an option
    // and DIVE is the rational play.
    const s = makeState({
      width: 10,
      height: 5,
      defaultTerrain: 'plain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 2 } },
        { owner: 1, pos: { x: 9, y: 2 } },
      ],
      tiles: [
        { pos: { x: 3, y: 0 }, terrain: 'sea' },
        { pos: { x: 3, y: 1 }, terrain: 'sea' },
        { pos: { x: 3, y: 2 }, terrain: 'sea' },
        { pos: { x: 3, y: 3 }, terrain: 'sea' },
        { pos: { x: 3, y: 4 }, terrain: 'sea' },
      ],
      units: [
        { type: 'submarine', owner: 0, pos: { x: 3, y: 2 } },
        { type: 'artillery', owner: 1, pos: { x: 5, y: 2 } },
      ],
    });
    const subId = Object.values(s.units).find((u) => u.type === 'submarine')!.id;
    const plan = aiPlan(s);
    const dove = plan.some((a) => a.type === 'DIVE' && a.unitId === subId);
    expect(dove).toBe(true);
  });
});

// ─────────────────────────── Layer 2: LOAD / UNLOAD ──────────────────────────

describe('AI amphibious: LOAD', () => {
  it('yields a LOAD candidate when an infantry is adjacent to a friendly transport', () => {
    const s = makeState({
      width: 5,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 2, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'transport', owner: 0, pos: { x: 2, y: 0 } },
      ],
    });
    const infId = Object.values(s.units).find((u) => u.type === 'infantry')!.id;
    const types = candidateActions(s, infId);
    expect(types).toContain('LOAD');
  });

  it('utility AI loads an idle infantry onto an adjacent transport when no better option', () => {
    // Infantry on a peninsula; can't reach the enemy land without the boat.
    // Friendly transport adjacent. Should LOAD (vs. stand around).
    const s = makeState({
      width: 8,
      height: 3,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 7, y: 1 } },
      ],
      tiles: [
        // Friendly side: two land tiles + transport at sea.
        { pos: { x: 0, y: 1 }, terrain: 'hq', owner: 0 },
        { pos: { x: 1, y: 1 }, terrain: 'plain' },
        // Enemy side: hq + plain.
        { pos: { x: 7, y: 1 }, terrain: 'hq', owner: 1 },
        { pos: { x: 6, y: 1 }, terrain: 'plain' },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 1 } },
        { type: 'transport', owner: 0, pos: { x: 2, y: 1 } },
        // Dummy enemy unit so the win-by-rout check doesn't fire after the
        // very first reducer dispatch.
        { type: 'infantry', owner: 1, pos: { x: 6, y: 1 } },
      ],
    });
    const infId = Object.values(s.units).find((u) => u.type === 'infantry')!.id;
    const transportId = Object.values(s.units).find((u) => u.type === 'transport')!.id;
    const plan = aiPlan(s);
    const loaded = plan.some(
      (a) => a.type === 'LOAD' && a.cargoId === infId && a.transportId === transportId,
    );
    expect(loaded).toBe(true);
  });
});

describe('AI amphibious: UNLOAD', () => {
  it('yields an UNLOAD candidate for a transport carrying infantry next to land', () => {
    // Transport at (2,1) with infantry loaded, adjacent to plain tile (3,1)
    // which is itself adjacent to an enemy city at (4,1).
    let s = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 5, y: 1 } },
      ],
      tiles: [
        { pos: { x: 3, y: 1 }, terrain: 'plain' },
        { pos: { x: 4, y: 1 }, terrain: 'city', owner: 1 },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 2, y: 1 } },
        { type: 'transport', owner: 0, pos: { x: 2, y: 1 }, hp: 100 },
      ],
    });
    // Manually load the infantry: bypass LOAD's path check by setting fields.
    const [infId, transportId] = Object.keys(s.units);
    s = {
      ...s,
      units: {
        ...s.units,
        [infId!]: {
          ...s.units[infId!]!,
          loadedIn: transportId!,
          pos: { x: 2, y: 1 },
          hasMoved: true,
          hasActed: true,
        },
        [transportId!]: {
          ...s.units[transportId!]!,
          cargo: [infId!],
          pos: { x: 2, y: 1 },
        },
      },
    };
    const types = candidateActions(s, transportId!);
    expect(types).toContain('UNLOAD');
  });

  it('utility AI unloads infantry onto land adjacent to an enemy capturable', () => {
    let s = makeState({
      width: 8,
      height: 3,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 7, y: 1 } },
      ],
      tiles: [
        { pos: { x: 0, y: 1 }, terrain: 'hq', owner: 0 },
        { pos: { x: 1, y: 1 }, terrain: 'plain' },
        { pos: { x: 5, y: 1 }, terrain: 'plain' },
        { pos: { x: 6, y: 1 }, terrain: 'city', owner: 1 },
        { pos: { x: 7, y: 1 }, terrain: 'hq', owner: 1 },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 4, y: 1 } },
        { type: 'transport', owner: 0, pos: { x: 4, y: 1 } },
        // Dummy enemy unit so the rout check stays inert.
        { type: 'infantry', owner: 1, pos: { x: 7, y: 1 } },
      ],
    });
    const [infId, transportId] = Object.keys(s.units);
    s = {
      ...s,
      units: {
        ...s.units,
        [infId!]: {
          ...s.units[infId!]!,
          loadedIn: transportId!,
          hasMoved: true,
          hasActed: true,
        },
        [transportId!]: {
          ...s.units[transportId!]!,
          cargo: [infId!],
        },
      },
    };
    const plan = aiPlan(s);
    const unloaded = plan.some(
      (a) =>
        a.type === 'UNLOAD' &&
        a.transportId === transportId &&
        a.cargoId === infId,
    );
    expect(unloaded).toBe(true);
  });
});

// ─────────────────────────── Layer 2 MOVE+UNLOAD chain ───────────────────────

describe('AI amphibious: MOVE+UNLOAD chain', () => {
  it('a transport with cargo emits MOVE+UNLOAD candidates onto land within move range', () => {
    // Transport at (2,1) on sea, cargo aboard, target land tile at (5,1)
    // reachable in 3 sea steps; transport's move budget is 6.
    let s = makeState({
      width: 8,
      height: 3,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 7, y: 1 } },
      ],
      tiles: [
        { pos: { x: 5, y: 1 }, terrain: 'plain' },
        { pos: { x: 6, y: 1 }, terrain: 'city', owner: 1 },
        { pos: { x: 7, y: 1 }, terrain: 'hq', owner: 1 },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 2, y: 1 } },
        { type: 'transport', owner: 0, pos: { x: 2, y: 1 } },
        // Dummy enemy unit so the rout check stays inert when we reduce.
        { type: 'infantry', owner: 1, pos: { x: 7, y: 1 } },
      ],
    });
    const ids = Object.keys(s.units);
    const infId = ids[0]!;
    const transportId = ids[1]!;
    s = {
      ...s,
      units: {
        ...s.units,
        [infId]: {
          ...s.units[infId]!,
          loadedIn: transportId,
          hasMoved: true,
          hasActed: true,
        },
        [transportId]: {
          ...s.units[transportId]!,
          cargo: [infId],
        },
      },
    };
    // Enumerate transport candidates; expect at least one UNLOAD whose
    // followUp's transport tile is NOT the starting tile.
    const t = s.units[transportId]!;
    let foundMoveUnload = false;
    for (const c of generateCandidates(s, t)) {
      if (c.followUp.type === 'UNLOAD' && c.moveAction) {
        foundMoveUnload = true;
        break;
      }
    }
    expect(foundMoveUnload).toBe(true);
  });
});

// ─────────────────────────── Layer 3: Carrier ────────────────────────────────

describe('AI amphibious: carrier LOAD / UNLOAD', () => {
  it('yields LOAD when a friendly fighter is adjacent to a carrier', () => {
    const s = makeState({
      width: 5,
      height: 3,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 4, y: 1 } },
      ],
      units: [
        { type: 'fighter', owner: 0, pos: { x: 1, y: 1 } },
        { type: 'carrier', owner: 0, pos: { x: 2, y: 1 } },
      ],
    });
    const fighterId = Object.values(s.units).find((u) => u.type === 'fighter')!.id;
    const types = candidateActions(s, fighterId);
    expect(types).toContain('LOAD');
  });

  it('carrier with a loaded fighter yields UNLOAD candidates onto adjacent sea', () => {
    let s = makeState({
      width: 6,
      height: 3,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 5, y: 1 } },
      ],
      units: [
        { type: 'fighter', owner: 0, pos: { x: 2, y: 1 } },
        { type: 'carrier', owner: 0, pos: { x: 2, y: 1 } },
      ],
    });
    const [fighterId, carrierId] = Object.keys(s.units);
    s = {
      ...s,
      units: {
        ...s.units,
        [fighterId!]: {
          ...s.units[fighterId!]!,
          loadedIn: carrierId!,
          hasMoved: true,
          hasActed: true,
        },
        [carrierId!]: {
          ...s.units[carrierId!]!,
          cargo: [fighterId!],
        },
      },
    };
    const types = candidateActions(s, carrierId!);
    expect(types).toContain('UNLOAD');
  });
});

// ─────────────────────────── Legality safety net ────────────────────────────

describe('AI amphibious: never emits an illegal action across an armada turn', () => {
  it('balanced persona plays out cleanly on armada', () => {
    // Smoke test: load armada, run a single turn for player 0 with the
    // balanced persona, verify every emitted action is legal.
    let state: GameState = loadMap(armadaMap);
    const ai = personaAI('balanced');
    const rng = createRng(7);
    const plan = ai.takeTurn({ state, player: state.currentPlayer, rng });
    for (const a of plan) {
      expect(isLegalAction(state, a).legal).toBe(true);
      state = reduce(state, a);
      if (state.winner !== null) break;
    }
  });
});
