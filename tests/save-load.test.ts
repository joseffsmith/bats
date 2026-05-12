// Phase 6 save/load tests.
//
// Round-trip equality for several constructed states + clear errors on
// envelope corruption. The reducer is pure, so we can construct
// post-many-actions states by replaying through `reduce`.

import { describe, expect, it } from 'vitest';
import duelMap from '../src/data/maps/duel.json';
import canyonMap from '../src/data/maps/canyon.json';
import { loadMap } from '../src/engine/data/loader';
import { reduce } from '../src/engine/core/reducer';
import { serialize, deserialize, SAVE_SCHEMA_VERSION } from '../src/engine/save';
import type { Action, GameState } from '../src/engine/core/types';

function applyAll(state: GameState, actions: readonly Action[]): GameState {
  let s = state;
  for (const a of actions) s = reduce(s, a);
  return s;
}

describe('save/load', () => {
  it('round-trips the initial duel state byte-for-byte (structurally)', () => {
    const state = loadMap(duelMap);
    const json = serialize(state);
    const round = deserialize(json);
    expect(round).toEqual(state);
  });

  it('round-trips a canyon state advanced by several turns', () => {
    const state = loadMap(canyonMap);
    // Move p0 infantry, then end turn, build something via cheat-funds setup.
    const u = Object.values(state.units).find((u) => u.owner === 0)!;
    const after = applyAll(state, [
      { type: 'MOVE', unitId: u.id, path: [{ x: u.pos.x + 1, y: u.pos.y }] },
      { type: 'WAIT', unitId: u.id },
      { type: 'END_TURN' },
      { type: 'END_TURN' },
    ]);
    const json = serialize(after);
    const round = deserialize(json);
    expect(round).toEqual(after);
    expect(round.turn).toBe(after.turn);
  });

  it('round-trips an attack outcome (units killed, hp altered)', () => {
    const state = loadMap(duelMap);
    // Place p0 + p1 infantry adjacent by mutating positions in a clone.
    const adj = structuredClone(state);
    const p0 = Object.values(adj.units).find((u) => u.owner === 0)!;
    const p1 = Object.values(adj.units).find((u) => u.owner === 1)!;
    p1.pos = { x: p0.pos.x + 1, y: p0.pos.y };
    const after = reduce(adj, { type: 'ATTACK', attackerId: p0.id, targetId: p1.id });
    const json = serialize(after);
    const round = deserialize(json);
    expect(round).toEqual(after);
  });

  it('envelope contains the schema version', () => {
    const state = loadMap(duelMap);
    const env = JSON.parse(serialize(state)) as { version: number; kind: string };
    expect(env.version).toBe(SAVE_SCHEMA_VERSION);
    expect(env.kind).toBe('bats-save');
  });

  it('throws on wrong schema version', () => {
    const state = loadMap(duelMap);
    const env = JSON.parse(serialize(state)) as { version: number };
    env.version = 999;
    expect(() => deserialize(JSON.stringify(env))).toThrow(/schema version mismatch/);
  });

  it('throws on wrong envelope kind', () => {
    const env = { kind: 'other-thing', version: 1, state: {} };
    expect(() => deserialize(JSON.stringify(env))).toThrow(/wrong kind/);
  });

  it('throws on malformed JSON', () => {
    expect(() => deserialize('{ not json')).toThrow(/invalid JSON/);
  });

  it('throws when state payload is missing', () => {
    const env = { kind: 'bats-save', version: SAVE_SCHEMA_VERSION };
    expect(() => deserialize(JSON.stringify(env))).toThrow(/missing state payload/);
  });

  it('throws when state misses a required field', () => {
    const state = loadMap(duelMap);
    const env = JSON.parse(serialize(state)) as { state: Record<string, unknown> };
    delete env.state.turn;
    expect(() => deserialize(JSON.stringify(env))).toThrow(/missing field "turn"/);
  });
});
