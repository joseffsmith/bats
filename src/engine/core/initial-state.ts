// Minimal initial-state factory for Phase 1 tests.
//
// Phase 2 will replace this with a JSON map loader; for now it accepts a
// terse description sufficient to spin up a deterministic starting state.

import type {
  Coord,
  GameState,
  PlayerId,
  Tile,
  TerrainType,
  Unit,
  UnitType,
} from './types';

export type InitialUnitSpec = {
  type: UnitType;
  owner: PlayerId;
  pos: Coord;
  /** Optional override; defaults to 100. */
  hp?: number;
};

export type InitialTileOverride = {
  pos: Coord;
  terrain: TerrainType;
  owner?: PlayerId | null;
};

export type InitialMapSpec = {
  width: number;
  height: number;
  /** Default terrain for all unspecified tiles. Defaults to 'plain'. */
  defaultTerrain?: TerrainType;
  hqs: ReadonlyArray<{ owner: PlayerId; pos: Coord }>;
  tiles?: ReadonlyArray<InitialTileOverride>;
  units?: ReadonlyArray<InitialUnitSpec>;
  /** Starting funds per player. Defaults to 0. */
  funds?: Partial<Record<PlayerId, number>>;
};

export function createInitialState(spec: InitialMapSpec): GameState {
  const defaultTerrain: TerrainType = spec.defaultTerrain ?? 'plain';
  const map: Tile[][] = [];
  for (let y = 0; y < spec.height; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < spec.width; x++) {
      row.push({ terrain: defaultTerrain, owner: null });
    }
    map.push(row);
  }

  // Lay HQs.
  for (const { owner, pos } of spec.hqs) {
    const row = map[pos.y];
    if (!row) throw new Error(`HQ pos out of bounds: ${pos.x},${pos.y}`);
    if (pos.x < 0 || pos.x >= spec.width) {
      throw new Error(`HQ pos out of bounds: ${pos.x},${pos.y}`);
    }
    row[pos.x] = { terrain: 'hq', owner };
  }

  // Tile overrides (don't clobber HQs unless explicitly overridden).
  for (const t of spec.tiles ?? []) {
    const row = map[t.pos.y];
    if (!row) throw new Error(`tile override out of bounds: ${t.pos.x},${t.pos.y}`);
    if (t.pos.x < 0 || t.pos.x >= spec.width) {
      throw new Error(`tile override out of bounds: ${t.pos.x},${t.pos.y}`);
    }
    row[t.pos.x] = { terrain: t.terrain, owner: t.owner ?? null };
  }

  const units: Record<string, Unit> = {};
  let next = 1;
  for (const u of spec.units ?? []) {
    const id = `u${next++}`;
    units[id] = {
      id,
      type: u.type,
      owner: u.owner,
      pos: { x: u.pos.x, y: u.pos.y },
      hp: u.hp ?? 100,
      hasMoved: false,
      hasActed: false,
      captureProgress: 0,
    };
  }

  const playersById = spec.hqs.reduce<Record<PlayerId, { funds: number; hq: Coord }>>(
    (acc, h) => {
      acc[h.owner] = {
        funds: spec.funds?.[h.owner] ?? 0,
        hq: { x: h.pos.x, y: h.pos.y },
      };
      return acc;
    },
    {} as Record<PlayerId, { funds: number; hq: Coord }>,
  );

  // Both players must be defined.
  if (playersById[0] === undefined || playersById[1] === undefined) {
    throw new Error('createInitialState: both players need an HQ');
  }

  return {
    turn: 1,
    currentPlayer: 0,
    map,
    units,
    players: playersById,
    phase: 'idle',
    winner: null,
    nextUnitId: next,
  };
}
