// Hand-rolled validating loaders for Phase 2 JSON data.
//
// Each loader takes `unknown` (parsed JSON) and returns the strongly typed
// engine table, or throws a descriptive Error citing the JSON path of the
// offending field. We deliberately avoid Zod / io-ts: the data is small,
// the schemas are stable, and a dependency-free validator is more honest.
//
// Conventions:
// - `null` in JSON for movement cost means "impassable" (Infinity).
// - Loaders are pure: no globals, no fs, no console. The caller decides
//   where the JSON came from.
// - On success, the returned tables are deeply frozen so engine code cannot
//   accidentally mutate them.

import type {
  Coord,
  GameState,
  MovementClass,
  PlayerId,
  TerrainType,
  Tile,
  Unit,
  UnitType,
} from '../core/types';

// ─────────────────────────── Types exposed to engine ──────────────────────────

export type UnitDef = {
  cost: number;
  move: number;
  movementClass: MovementClass;
  minRange: number;
  maxRange: number;
  canCapture: boolean;
  indirect: boolean;
  /** Maximum number of units this transport can carry. 0 = not a transport. */
  cargoCapacity: number;
  /** Movement classes accepted as cargo. Empty = not a transport. */
  cargoMovementClasses: ReadonlyArray<MovementClass>;
  /**
   * Manhattan radius this unit can see for fog-of-war purposes. The unit's own
   * tile is always visible regardless of value. Submarines are special: this
   * is the surfaced vision; submerged subs see only their own tile + adjacent.
   */
  visionRange: number;
};

export type TerrainDef = {
  defenseStars: number;
  /** Movement cost per movement class. Infinity = impassable. */
  moveCost: Record<MovementClass, number>;
};

export type AIWeights = {
  damageDealt: number;
  capture: number;
  counterRisk: number;
  futureThreat: number;
  positional: number;
  objective: number;
};

// ─────────────────────────── Constants for validation ─────────────────────────

const UNIT_TYPES: ReadonlyArray<UnitType> = [
  'infantry',
  'recon',
  'tank',
  'artillery',
  'copter',
  'transport',
  'fighter',
  'bomber',
  'battleship',
  'cruiser',
  'aatank',
  'lander',
  'submarine',
  'carrier',
];

const TERRAIN_TYPES: ReadonlyArray<TerrainType> = [
  'plain',
  'road',
  'forest',
  'mountain',
  'sea',
  'city',
  'hq',
  'factory',
];

const MOVEMENT_CLASSES: ReadonlyArray<MovementClass> = [
  'foot',
  'wheel',
  'tread',
  'air',
  'sea',
];

const AI_WEIGHT_KEYS: ReadonlyArray<keyof AIWeights> = [
  'damageDealt',
  'capture',
  'counterRisk',
  'futureThreat',
  'positional',
  'objective',
];

// ─────────────────────────── Validation primitives ────────────────────────────

function fail(path: string, msg: string): never {
  throw new Error(`${path}: ${msg}`);
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, `expected object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, `expected array, got ${describe(value)}`);
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, `expected string, got ${describe(value)}`);
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, `expected finite number, got ${describe(value)}`);
  }
  return value;
}

function asInt(value: unknown, path: string): number {
  const n = asNumber(value, path);
  if (!Number.isInteger(n)) fail(path, `expected integer, got ${n}`);
  return n;
}

function asNonNegInt(value: unknown, path: string): number {
  const n = asInt(value, path);
  if (n < 0) fail(path, `expected non-negative integer, got ${n}`);
  return n;
}

function asPositiveInt(value: unknown, path: string): number {
  const n = asInt(value, path);
  if (n <= 0) fail(path, `expected positive integer, got ${n}`);
  return n;
}

function asBool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, `expected boolean, got ${describe(value)}`);
  return value;
}

function asEnum<T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
  path: string,
): T {
  const s = asString(value, path);
  if (!allowed.includes(s as T)) {
    fail(path, `expected one of [${allowed.join(', ')}], got "${s}"`);
  }
  return s as T;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const k of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[k];
    if (child !== null && typeof child === 'object') deepFreeze(child);
  }
  return value;
}

// ─────────────────────────── Loaders ──────────────────────────────────────────

export function loadUnits(json: unknown): Record<UnitType, UnitDef> {
  const arr = asArray(json, 'units');
  const out = {} as Record<UnitType, UnitDef>;
  const seen = new Set<UnitType>();
  for (let i = 0; i < arr.length; i++) {
    const path = `units[${i}]`;
    const o = asObject(arr[i], path);
    const type = asEnum(o.type, UNIT_TYPES, `${path}.type`);
    if (seen.has(type)) fail(`${path}.type`, `duplicate unit type "${type}"`);
    seen.add(type);
    // Cargo fields are optional; default to non-transport (0 / []).
    let cargoCapacity = 0;
    let cargoMovementClasses: ReadonlyArray<MovementClass> = [];
    if ('cargoCapacity' in o && o.cargoCapacity !== undefined) {
      cargoCapacity = asNonNegInt(o.cargoCapacity, `${path}.cargoCapacity`);
    }
    if ('cargoMovementClasses' in o && o.cargoMovementClasses !== undefined) {
      const arrCm = asArray(o.cargoMovementClasses, `${path}.cargoMovementClasses`);
      cargoMovementClasses = arrCm.map((v, j) =>
        asEnum(v, MOVEMENT_CLASSES, `${path}.cargoMovementClasses[${j}]`),
      );
    }
    const def: UnitDef = {
      cost: asNonNegInt(o.cost, `${path}.cost`),
      move: asPositiveInt(o.move, `${path}.move`),
      movementClass: asEnum(
        o.movementClass,
        MOVEMENT_CLASSES,
        `${path}.movementClass`,
      ),
      // Transports are non-combat (minRange=maxRange=0); attack validators
      // gate on `maxRange > 0` so we allow 0 here.
      minRange: asNonNegInt(o.minRange, `${path}.minRange`),
      maxRange: asNonNegInt(o.maxRange, `${path}.maxRange`),
      canCapture: asBool(o.canCapture, `${path}.canCapture`),
      indirect: asBool(o.indirect, `${path}.indirect`),
      cargoCapacity,
      cargoMovementClasses,
      visionRange: asNonNegInt(o.visionRange, `${path}.visionRange`),
    };
    if (def.minRange > def.maxRange) {
      fail(path, `minRange (${def.minRange}) > maxRange (${def.maxRange})`);
    }
    if (def.cost < 0) fail(`${path}.cost`, `negative cost ${def.cost}`);
    out[type] = def;
  }
  for (const t of UNIT_TYPES) {
    if (!(t in out)) fail('units', `missing unit type "${t}"`);
  }
  return deepFreeze(out);
}

function asMoveCostValue(value: unknown, path: string): number {
  if (value === null) return Infinity;
  const n = asNumber(value, path);
  if (n <= 0) fail(path, `expected positive number or null, got ${n}`);
  return n;
}

export function loadTerrain(json: unknown): Record<TerrainType, TerrainDef> {
  const arr = asArray(json, 'terrain');
  const out = {} as Record<TerrainType, TerrainDef>;
  const seen = new Set<TerrainType>();
  for (let i = 0; i < arr.length; i++) {
    const path = `terrain[${i}]`;
    const o = asObject(arr[i], path);
    const terrain = asEnum(o.terrain, TERRAIN_TYPES, `${path}.terrain`);
    if (seen.has(terrain)) fail(`${path}.terrain`, `duplicate terrain "${terrain}"`);
    seen.add(terrain);
    const stars = asNonNegInt(o.defenseStars, `${path}.defenseStars`);
    if (stars > 10) fail(`${path}.defenseStars`, `implausibly high (${stars})`);
    const mc = asObject(o.moveCost, `${path}.moveCost`);
    const moveCost = {} as Record<MovementClass, number>;
    for (const cls of MOVEMENT_CLASSES) {
      if (!(cls in mc)) fail(`${path}.moveCost.${cls}`, 'missing key');
      moveCost[cls] = asMoveCostValue(mc[cls], `${path}.moveCost.${cls}`);
    }
    out[terrain] = { defenseStars: stars, moveCost };
  }
  for (const t of TERRAIN_TYPES) {
    if (!(t in out)) fail('terrain', `missing terrain type "${t}"`);
  }
  return deepFreeze(out);
}

export function loadDamage(
  json: unknown,
  units?: Record<UnitType, UnitDef>,
): Record<UnitType, Record<UnitType, number>> {
  const o = asObject(json, 'damage');
  const out = {} as Record<UnitType, Record<UnitType, number>>;
  // Every attacker row must be present and reference only known unit types.
  for (const attacker of UNIT_TYPES) {
    const rowPath = `damage.${attacker}`;
    if (!(attacker in o)) fail(rowPath, 'missing attacker row');
    const row = asObject(o[attacker], rowPath);
    const cells = {} as Record<UnitType, number>;
    for (const defender of UNIT_TYPES) {
      const cellPath = `${rowPath}.${defender}`;
      if (!(defender in row)) fail(cellPath, 'missing defender cell');
      const v = asNumber(row[defender], cellPath);
      if (v < 0 || v > 200) fail(cellPath, `damage out of plausible range (${v})`);
      cells[defender] = v;
    }
    // Reject unknown extra keys to catch typos.
    for (const k of Object.keys(row)) {
      if (!UNIT_TYPES.includes(k as UnitType)) {
        fail(`${rowPath}.${k}`, 'unknown defender unit type');
      }
    }
    out[attacker] = cells;
  }
  for (const k of Object.keys(o)) {
    if (!UNIT_TYPES.includes(k as UnitType)) {
      fail(`damage.${k}`, 'unknown attacker unit type');
    }
  }
  // Optional cross-check against units table.
  if (units) {
    for (const t of UNIT_TYPES) {
      if (!(t in units)) fail('damage', `unit type "${t}" missing from units table`);
    }
  }
  return deepFreeze(out);
}

export function loadAIWeights(json: unknown): AIWeights {
  const o = asObject(json, 'aiWeights');
  const out = {} as AIWeights;
  for (const k of AI_WEIGHT_KEYS) {
    if (!(k in o)) fail(`aiWeights.${k}`, 'missing key');
    const v = asNumber(o[k], `aiWeights.${k}`);
    if (v < 0) fail(`aiWeights.${k}`, `expected non-negative, got ${v}`);
    out[k] = v;
  }
  for (const k of Object.keys(o)) {
    if (!AI_WEIGHT_KEYS.includes(k as keyof AIWeights)) {
      fail(`aiWeights.${k}`, 'unknown weight key');
    }
  }
  return deepFreeze(out);
}

// ─────────────────────────── Map loader ───────────────────────────────────────

type LegendEntry = { terrain: TerrainType; owner?: PlayerId };

function loadLegend(json: unknown): Record<string, LegendEntry> {
  const o = asObject(json, 'tileLegend');
  const legend: Record<string, LegendEntry> = {};
  for (const sym of Object.keys(o)) {
    if (sym.length !== 1) {
      fail(`tileLegend.${sym}`, 'legend symbol must be a single character');
    }
    const entry = asObject(o[sym], `tileLegend.${sym}`);
    const terrain = asEnum(entry.terrain, TERRAIN_TYPES, `tileLegend.${sym}.terrain`);
    const out: LegendEntry = { terrain };
    if ('owner' in entry && entry.owner !== undefined && entry.owner !== null) {
      const owner = asInt(entry.owner, `tileLegend.${sym}.owner`);
      if (owner !== 0 && owner !== 1) {
        fail(`tileLegend.${sym}.owner`, `expected 0 or 1, got ${owner}`);
      }
      out.owner = owner as PlayerId;
    }
    legend[sym] = out;
  }
  return legend;
}

function asPlayerId(value: unknown, path: string): PlayerId {
  const n = asInt(value, path);
  if (n !== 0 && n !== 1) fail(path, `expected 0 or 1, got ${n}`);
  return n as PlayerId;
}

function asCoord(value: unknown, path: string): Coord {
  const o = asObject(value, path);
  return {
    x: asNonNegInt(o.x, `${path}.x`),
    y: asNonNegInt(o.y, `${path}.y`),
  };
}

export function loadMap(json: unknown): GameState {
  const o = asObject(json, 'map');
  const name = asString(o.name, 'map.name');
  const width = asPositiveInt(o.width, 'map.width');
  const height = asPositiveInt(o.height, 'map.height');
  const tiles = asArray(o.tiles, 'map.tiles');
  if (tiles.length !== height) {
    fail('map.tiles', `expected ${height} rows, got ${tiles.length}`);
  }
  const legend = loadLegend(o.tileLegend);

  // Build the tile grid.
  const grid: Tile[][] = [];
  for (let y = 0; y < height; y++) {
    const rowPath = `map.tiles[${y}]`;
    const row = asString(tiles[y], rowPath);
    if (row.length !== width) {
      fail(rowPath, `expected ${width} chars, got ${row.length}`);
    }
    const gridRow: Tile[] = [];
    for (let x = 0; x < width; x++) {
      const sym = row[x];
      if (sym === undefined) fail(`${rowPath}[${x}]`, 'undefined cell');
      const entry = legend[sym];
      if (!entry) {
        fail(`${rowPath}[${x}]`, `symbol "${sym}" not in tileLegend`);
      }
      const tile: Tile = { terrain: entry.terrain, owner: null };
      if (entry.owner !== undefined) tile.owner = entry.owner;
      gridRow.push(tile);
    }
    grid.push(gridRow);
  }

  // Players block.
  const playersJson = asObject(o.players, 'map.players');
  const players = {} as Record<PlayerId, { funds: number; hq: Coord }>;
  for (const key of ['0', '1'] as const) {
    if (!(key in playersJson)) fail(`map.players.${key}`, 'missing player block');
    const p = asObject(playersJson[key], `map.players.${key}`);
    const funds = asNonNegInt(p.funds, `map.players.${key}.funds`);
    const hq = asCoord(p.hq, `map.players.${key}.hq`);
    if (hq.x >= width || hq.y >= height) {
      fail(`map.players.${key}.hq`, `out of bounds (${hq.x},${hq.y})`);
    }
    players[Number(key) as PlayerId] = { funds, hq };
  }

  // Validate that each player's HQ coord matches an HQ tile owned by them.
  for (const pid of [0, 1] as PlayerId[]) {
    const hq = players[pid].hq;
    const tile = grid[hq.y]?.[hq.x];
    if (!tile) fail(`map.players.${pid}.hq`, 'HQ coord out of map bounds');
    if (tile.terrain !== 'hq') {
      fail(
        `map.players.${pid}.hq`,
        `HQ coord points at "${tile.terrain}", not "hq"`,
      );
    }
    if (tile.owner !== pid) {
      fail(
        `map.players.${pid}.hq`,
        `HQ tile owner ${tile.owner} does not match player ${pid}`,
      );
    }
  }

  // Confirm every HQ tile in the grid is owned by the correct player and the
  // players block lists it. (Catches an orphan HQ tile that no player owns.)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tile = grid[y]![x]!;
      if (tile.terrain !== 'hq') continue;
      if (tile.owner === null) {
        fail(`map.tiles[${y}][${x}]`, 'HQ tile has no owner');
      }
      const declared = players[tile.owner].hq;
      if (declared.x !== x || declared.y !== y) {
        fail(
          `map.tiles[${y}][${x}]`,
          `HQ tile at (${x},${y}) does not match players.${tile.owner}.hq (${declared.x},${declared.y})`,
        );
      }
    }
  }

  // Units.
  const unitsJson = asArray(o.units ?? [], 'map.units');
  const unitsOut: Record<string, Unit> = {};
  let nextId = 1;
  for (let i = 0; i < unitsJson.length; i++) {
    const path = `map.units[${i}]`;
    const u = asObject(unitsJson[i], path);
    const type = asEnum(u.type, UNIT_TYPES, `${path}.type`);
    const owner = asPlayerId(u.owner, `${path}.owner`);
    const pos = asCoord(u.pos, `${path}.pos`);
    if (pos.x >= width || pos.y >= height) {
      fail(`${path}.pos`, `out of bounds (${pos.x},${pos.y})`);
    }
    const hp = u.hp === undefined ? 100 : asInt(u.hp, `${path}.hp`);
    if (hp <= 0 || hp > 100) fail(`${path}.hp`, `expected 1..100, got ${hp}`);
    const id = `u${nextId++}`;
    // Cross-check: no two units on the same tile.
    for (const other of Object.values(unitsOut)) {
      if (other.pos.x === pos.x && other.pos.y === pos.y) {
        fail(`${path}.pos`, `tile (${pos.x},${pos.y}) already occupied by ${other.id}`);
      }
    }
    unitsOut[id] = {
      id,
      type,
      owner,
      pos,
      hp,
      hasMoved: false,
      hasActed: false,
      captureProgress: 0,
    };
  }

  // Map name unused by the engine itself; kept on the resulting state for
  // debugging via reflection (attached as a non-enumerable for now? — simpler
  // to just discard it. CLI logs the name separately).
  void name;

  return {
    turn: 1,
    currentPlayer: 0,
    map: grid,
    units: unitsOut,
    players,
    phase: 'idle',
    winner: null,
    nextUnitId: nextId,
  };
}
