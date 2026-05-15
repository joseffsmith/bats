// Core engine types. Anchor for everything; match PLAN.md.

export type PlayerId = 0 | 1;
export type UnitId = string;
export type Coord = { x: number; y: number };

export type MovementClass = 'foot' | 'wheel' | 'tread' | 'air' | 'sea';
export type UnitType =
  | 'infantry'
  | 'recon'
  | 'tank'
  | 'artillery'
  | 'copter'
  | 'transport'
  | 'fighter'
  | 'bomber'
  | 'battleship'
  | 'cruiser'
  | 'aatank'
  | 'lander'
  | 'submarine'
  | 'carrier';

export type TerrainType =
  | 'plain'
  | 'road'
  | 'forest'
  | 'mountain'
  | 'sea'
  | 'city'
  | 'hq'
  | 'factory';

export type Unit = {
  id: UnitId;
  type: UnitType;
  owner: PlayerId;
  pos: Coord;
  hp: number; // 0–100, displayed as 1–10
  hasMoved: boolean;
  hasActed: boolean;
  captureProgress: number; // 0–20, accumulates on capturable tile
  // ── Transport cargo model ────────────────────────────────────────────────
  // A transport's manifest: ids of currently-loaded units. Loaded units stay
  // in `state.units` with their `loadedIn` set to this transport's id; their
  // `pos` mirrors the transport's pos. `unitAt` and combat-range selectors
  // skip loaded units, so cargo is unreachable while embarked.
  //
  // When a transport is destroyed by combat, every unit listed in `cargo` is
  // destroyed with it (see reducer.applyAttack).
  cargo?: UnitId[];
  // Back-pointer set on a loaded unit: the id of the carrying transport.
  // Absent on free-standing units. Cleared on UNLOAD.
  loadedIn?: UnitId;
  // ── Submarine stealth ───────────────────────────────────────────────────
  // Only meaningful on `type === 'submarine'`. When true the sub is dived
  // and hidden from observers without a cruiser or submarine within
  // Manhattan distance 1. Persists across turns until a SURFACE action
  // toggles it off. `unitAt` (engine truth) still sees the sub on its tile;
  // `visibleUnitAt` is the viewer-aware variant used by the renderer/input
  // layer. See selectors.ts.
  submerged?: boolean;
};

export type Tile = {
  terrain: TerrainType;
  owner: PlayerId | null; // for capturable tiles
};

export type PlayerState = { funds: number; hq: Coord };

export type GameState = {
  turn: number;
  currentPlayer: PlayerId;
  map: Tile[][]; // indexed [y][x]
  units: Record<UnitId, Unit>;
  players: Record<PlayerId, PlayerState>;
  phase: 'idle' | 'animating';
  winner: PlayerId | null;
  /** Monotonic counter for unique unit ids; used by reducer + factories. */
  nextUnitId: number;
};

export type Action =
  | { type: 'MOVE'; unitId: UnitId; path: Coord[] }
  | { type: 'ATTACK'; attackerId: UnitId; targetId: UnitId }
  | { type: 'CAPTURE'; unitId: UnitId }
  | { type: 'BUILD'; at: Coord; unitType: UnitType; owner: PlayerId }
  | { type: 'WAIT'; unitId: UnitId }
  // LOAD: cargo unit walks `path` (ending on transport's tile) and is loaded
  // aboard. Combines MOVE + load-into-transport into a single action so the
  // normally-illegal "stop on a friendly unit's tile" check has a clear
  // exception. After LOAD: cargo.hasMoved = cargo.hasActed = true; cargo's
  // pos mirrors the transport's pos.
  | { type: 'LOAD'; cargoId: UnitId; transportId: UnitId; path: Coord[] }
  // UNLOAD: transport disembarks one of its cargo units onto `destination`
  // (an adjacent tile passable for the cargo's movement class, unoccupied).
  // Standard AW rule: both the transport AND the unloaded cargo are marked
  // hasActed (cargo cannot move again that turn).
  | { type: 'UNLOAD'; transportId: UnitId; cargoId: UnitId; destination: Coord }
  // DIVE: submarine transitions from surfaced to submerged. Same gating as
  // WAIT (own unit, not yet acted). After: hasMoved = hasActed = true and
  // submerged = true. Persists across turns.
  | { type: 'DIVE'; unitId: UnitId }
  // SURFACE: submarine transitions from submerged to surfaced. Mirror of
  // DIVE.
  | { type: 'SURFACE'; unitId: UnitId }
  | { type: 'END_TURN' };

export type LegalityResult =
  | { legal: true }
  | { legal: false; reason: string };

/** A capturable tile is one with an `owner` slot — city, hq, factory. */
export const CAPTURABLE_TERRAIN: ReadonlyArray<TerrainType> = [
  'city',
  'hq',
  'factory',
];

export function isCapturable(terrain: TerrainType): boolean {
  return CAPTURABLE_TERRAIN.includes(terrain);
}

export function coordEq(a: Coord, b: Coord): boolean {
  return a.x === b.x && a.y === b.y;
}

export function coordKey(c: Coord): string {
  return `${c.x},${c.y}`;
}

export function manhattan(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function otherPlayer(p: PlayerId): PlayerId {
  return (p === 0 ? 1 : 0) as PlayerId;
}

export function inBounds(map: Tile[][], c: Coord): boolean {
  if (map.length === 0) return false;
  const h = map.length;
  const row = map[0];
  if (!row) return false;
  const w = row.length;
  return c.x >= 0 && c.y >= 0 && c.x < w && c.y < h;
}

export function tileAt(map: Tile[][], c: Coord): Tile {
  const row = map[c.y];
  if (!row) throw new Error(`tileAt: out of bounds y=${c.y}`);
  const t = row[c.x];
  if (!t) throw new Error(`tileAt: out of bounds x=${c.x}`);
  return t;
}

export function unitAt(state: GameState, c: Coord): Unit | undefined {
  // Loaded units (cargo) share their carrier's position but are not present
  // on the tile for occupancy purposes — only the transport occupies the tile.
  for (const u of Object.values(state.units)) {
    if (u.loadedIn !== undefined) continue;
    if (coordEq(u.pos, c)) return u;
  }
  return undefined;
}
