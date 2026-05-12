// Strengthened movement coverage per Phase 1 acceptance criteria.
//
// Covers happy path, every blocked-movement reason (terrain ∞, occupied,
// edge, exceeds budget, enemy on path), pass-through friendly, copter
// terrain ignore, recon road-vs-forest cost differences, hasMoved gate,
// owner gate, winner gate, and capture-progress reset on MOVE.

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import { reduce } from '../src/engine/core/reducer';
import { reachableTiles, validatePath } from '../src/engine/systems/pathfinding';

describe('movement: happy path', () => {
  it('relocates the unit and sets hasMoved (only)', () => {
    const s = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const id = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const next = reduce(s, {
      type: 'MOVE',
      unitId: id,
      path: [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
      ],
    });
    expect(next.units[id]!.pos).toEqual({ x: 3, y: 0 });
    expect(next.units[id]!.hasMoved).toBe(true);
    expect(next.units[id]!.hasActed).toBe(false);
  });
});

describe('movement: blocked', () => {
  it('infantry blocked by sea (terrain ∞ for foot)', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'sea' }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const id = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const next = reduce(s, {
      type: 'MOVE',
      unitId: id,
      path: [{ x: 1, y: 0 }],
    });
    expect(next).toBe(s); // no-op
  });

  it('tank blocked by mountain (∞ for tread)', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'mountain' }],
      units: [
        { type: 'tank', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const id = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const next = reduce(s, {
      type: 'MOVE',
      unitId: id,
      path: [{ x: 1, y: 0 }],
    });
    expect(next).toBe(s);
  });

  it('recon (wheel) blocked by mountain (∞ for wheel)', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'mountain' }],
      units: [
        { type: 'recon', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const id = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const u = s.units[id]!;
    const r = validatePath(s, u, [{ x: 1, y: 0 }]);
    expect(r.ok).toBe(false);
  });

  it('move blocked by enemy unit on path (cannot pass through enemy)', () => {
    const s = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 1, y: 0 } },
      ],
    });
    const id = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const next = reduce(s, {
      type: 'MOVE',
      unitId: id,
      path: [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
    });
    expect(next).toBe(s);
  });

  it('pass-through own friendly is allowed but cannot END on it', () => {
    const s = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const moverId = Object.values(s.units).find(
      (u) => u.owner === 0 && u.pos.x === 0,
    )!.id;
    // Pass-through and stop on (2,0) → legal.
    const ok = reduce(s, {
      type: 'MOVE',
      unitId: moverId,
      path: [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
    });
    expect(ok.units[moverId]!.pos).toEqual({ x: 2, y: 0 });

    // Ending on the friendly tile is rejected.
    const bad = reduce(s, {
      type: 'MOVE',
      unitId: moverId,
      path: [{ x: 1, y: 0 }],
    });
    expect(bad).toBe(s);
  });

  it('cannot move off the map edge', () => {
    const s = makeState({
      width: 3,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const id = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const next = reduce(s, {
      type: 'MOVE',
      unitId: id,
      path: [{ x: -1, y: 0 }],
    });
    expect(next).toBe(s);
  });

  it('cannot move with a path exceeding the unit move budget', () => {
    // Infantry has move=3 on plain (cost 1). Path length 4 should fail.
    const s = makeState({
      width: 6,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 5, y: 0 } },
      ],
    });
    const id = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const next = reduce(s, {
      type: 'MOVE',
      unitId: id,
      path: [
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
        { x: 4, y: 0 },
      ],
    });
    expect(next).toBe(s);
  });

  it('cannot move a unit that already hasMoved (e.g., post-WAIT)', () => {
    const s = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const id = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const afterWait = reduce(s, { type: 'WAIT', unitId: id });
    expect(afterWait.units[id]!.hasMoved).toBe(true);
    const second = reduce(afterWait, {
      type: 'MOVE',
      unitId: id,
      path: [{ x: 1, y: 0 }],
    });
    expect(second).toBe(afterWait);
  });

  it("cannot move enemy player's unit", () => {
    const s = makeState({
      width: 4,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const enemyId = Object.values(s.units).find((u) => u.owner === 1)!.id;
    const next = reduce(s, {
      type: 'MOVE',
      unitId: enemyId,
      path: [{ x: 1, y: 0 }],
    });
    expect(next).toBe(s);
  });

  it('rejects MOVE once a winner is set', () => {
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
        // P1 has one weak infantry — killing it triggers rout win for P0.
        { type: 'infantry', owner: 1, pos: { x: 1, y: 0 }, hp: 10 },
      ],
    });
    const a = Object.values(s.units).find((u) => u.type === 'tank')!;
    const t = Object.values(s.units).find((u) => u.owner === 1)!;
    const after = reduce(s, { type: 'ATTACK', attackerId: a.id, targetId: t.id });
    expect(after.winner).toBe(0);
    // Any further action is a no-op (returns same ref).
    const tryMove = reduce(after, {
      type: 'MOVE',
      unitId: a.id,
      path: [{ x: 1, y: 0 }],
    });
    expect(tryMove).toBe(after);
  });

  it('rejects MOVE with destination equal to origin (path-empty edge case)', () => {
    const s = makeState({
      width: 3,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const id = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const empty = reduce(s, { type: 'MOVE', unitId: id, path: [] });
    expect(empty).toBe(s);
  });
});

describe('movement: per-movement-class terrain costs', () => {
  it('recon (wheel) reaches 8 on road but only 2 tiles deep through forest', () => {
    // 10 tiles wide road row: recon at x=0, can step 8 right on road.
    // Friendly is placed off the row to avoid blocking.
    const roadState = makeState({
      width: 10,
      height: 2,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 9, y: 1 } },
      ],
      units: [
        { type: 'recon', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 9, y: 1 } },
      ],
    });
    const recon = Object.values(roadState.units).find((u) => u.type === 'recon')!;
    const reach = reachableTiles(roadState, recon);
    const maxX = Math.max(...reach.map((r) => r.coord.x));
    expect(maxX).toBe(8); // 8 road tiles → costs 8, exactly the budget

    // Now all forest (wheel=3): budget=8 → at most floor(8/3) = 2 tiles in any direction.
    const forestState = makeState({
      width: 10,
      height: 2,
      defaultTerrain: 'forest',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 9, y: 1 } },
      ],
      units: [
        { type: 'recon', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 9, y: 1 } },
      ],
    });
    const r2 = Object.values(forestState.units).find((u) => u.type === 'recon')!;
    const reach2 = reachableTiles(forestState, r2);
    const maxX2 = Math.max(...reach2.map((r) => r.coord.x));
    expect(maxX2).toBeLessThanOrEqual(2);
  });

  it('copter (air) ignores ground costs — mountains, forest cost 1 each', () => {
    const s = makeState({
      width: 6,
      height: 2,
      defaultTerrain: 'mountain',
      hqs: [
        { owner: 0, pos: { x: 0, y: 1 } },
        { owner: 1, pos: { x: 5, y: 1 } },
      ],
      units: [
        { type: 'copter', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 5, y: 1 } },
      ],
    });
    const cop = Object.values(s.units).find((u) => u.type === 'copter')!;
    const reach = reachableTiles(s, cop);
    // copter move=6 over mountain (air cost 1) → x=4 reachable at cost 4.
    expect(reach.some((r) => r.coord.x === 4 && r.coord.y === 0 && r.cost === 4)).toBe(true);
    // x=5 is enemy infantry blocking destination, but x=5,y=0 should reach at cost 5.
    expect(reach.some((r) => r.coord.x === 5 && r.coord.y === 0 && r.cost === 5)).toBe(true);
  });

  it('infantry can step on mountain at cost 2 (foot cost)', () => {
    const s = makeState({
      width: 3,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 2, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'mountain' }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 2, y: 0 } },
      ],
    });
    const id = Object.values(s.units).find((u) => u.owner === 0)!.id;
    const next = reduce(s, {
      type: 'MOVE',
      unitId: id,
      path: [{ x: 1, y: 0 }],
    });
    expect(next.units[id]!.pos).toEqual({ x: 1, y: 0 });
  });
});

describe('movement: capture-progress reset on MOVE', () => {
  it('MOVE off a capturable tile resets captureProgress to 0', () => {
    const s = makeState({
      width: 5,
      height: 1,
      defaultTerrain: 'road',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 0 } },
      ],
      tiles: [{ pos: { x: 1, y: 0 }, terrain: 'city', owner: null }],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 1, y: 0 } },
        { type: 'infantry', owner: 1, pos: { x: 4, y: 0 } },
      ],
    });
    const infId = Object.values(s.units).find((u) => u.owner === 0)!.id;
    // Capture (progress = 10).
    let st = reduce(s, { type: 'CAPTURE', unitId: infId });
    expect(st.units[infId]!.captureProgress).toBe(10);
    // Pass turns to reset hasMoved/hasActed.
    st = reduce(st, { type: 'END_TURN' });
    st = reduce(st, { type: 'END_TURN' });
    // Move one step off.
    st = reduce(st, {
      type: 'MOVE',
      unitId: infId,
      path: [{ x: 2, y: 0 }],
    });
    expect(st.units[infId]!.captureProgress).toBe(0);
  });
});
