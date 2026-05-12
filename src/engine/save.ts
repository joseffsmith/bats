// Save / load envelope for GameState.
//
// The reducer architecture means GameState is already plain JSON: every field
// is a primitive, a Record of primitives, or a 2D array of plain objects. So
// serialise = JSON.stringify with a schema-version envelope. Deserialise =
// JSON.parse + version check + light structural validation (we don't re-run
// the map loader because the state is post-load: it may include units that
// were built mid-game, captured tiles, etc.).
//
// The envelope is:
//   { kind: 'bats-save'; version: 1; savedAt: <ISO>; state: GameState }
//
// Bump SAVE_SCHEMA_VERSION any time GameState's shape changes — old saves
// must then throw on load with a clear message.

import type { GameState } from './core/types';

/** Current schema version. Bump on any GameState shape change. */
export const SAVE_SCHEMA_VERSION = 1;

export const SAVE_KIND = 'bats-save';

export type SaveEnvelope = {
  kind: typeof SAVE_KIND;
  version: number;
  savedAt: string;
  state: GameState;
};

/** Serialise a GameState into a transport-friendly JSON string. */
export function serialize(state: GameState): string {
  const env: SaveEnvelope = {
    kind: SAVE_KIND,
    version: SAVE_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    state,
  };
  return JSON.stringify(env);
}

/**
 * Deserialise a save string back into a GameState. Validates the envelope's
 * kind + version, then performs a light structural check (no map walk —
 * trust the original loader's outputs).
 */
export function deserialize(json: string): GameState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`save deserialize: invalid JSON (${msg})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('save deserialize: expected object envelope');
  }
  const env = parsed as Partial<SaveEnvelope>;
  if (env.kind !== SAVE_KIND) {
    throw new Error(`save deserialize: wrong kind "${String(env.kind)}", expected "${SAVE_KIND}"`);
  }
  if (typeof env.version !== 'number') {
    throw new Error('save deserialize: missing version field');
  }
  if (env.version !== SAVE_SCHEMA_VERSION) {
    throw new Error(
      `save deserialize: schema version mismatch (file=${env.version}, runtime=${SAVE_SCHEMA_VERSION})`,
    );
  }
  if (!env.state || typeof env.state !== 'object' || Array.isArray(env.state)) {
    throw new Error('save deserialize: missing state payload');
  }
  validateShape(env.state);
  return env.state;
}

function validateShape(s: GameState): void {
  // Cheapest possible: structural-keys check + a couple of invariants.
  const required = [
    'turn',
    'currentPlayer',
    'map',
    'units',
    'players',
    'phase',
    'winner',
    'nextUnitId',
  ] as const;
  for (const k of required) {
    if (!(k in s)) throw new Error(`save deserialize: missing field "${k}"`);
  }
  if (!Array.isArray(s.map)) throw new Error('save deserialize: map not an array');
  if (typeof s.units !== 'object' || s.units === null) {
    throw new Error('save deserialize: units not an object');
  }
  if (typeof s.players !== 'object' || s.players === null) {
    throw new Error('save deserialize: players not an object');
  }
  if (!(0 in s.players) || !(1 in s.players)) {
    throw new Error('save deserialize: players must include keys 0 and 1');
  }
  // Spot-check a unit if any exist.
  for (const id of Object.keys(s.units)) {
    const u = s.units[id]!;
    if (typeof u.id !== 'string' || u.id !== id) {
      throw new Error(`save deserialize: unit id mismatch on ${id}`);
    }
    if (typeof u.hp !== 'number') {
      throw new Error(`save deserialize: unit ${id} has invalid hp`);
    }
  }
}

/** Trigger a browser download of a save JSON. Renderer-only helper. */
export function downloadSave(state: GameState, filename = 'bats-save.json'): void {
  const json = serialize(state);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
