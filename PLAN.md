# Tactical Engine — Project Handoff

A turn-based tactical strategy engine in the lineage of Advance Wars and the Battalion series. Engine-first: pure reducer, decoupled from rendering, with balance lived in JSON. The design emerges from parameter tuning, not from being committed to up front.

**v1 deliverable:** a playable hot-seat two-player tactical battle — grid map, ~5 unit types, capture-and-income economy, terrain effects, attack/defence with counterattacks, win by HQ capture or routing. Plus a heuristic AI good enough to play against.

---

## Tech Stack

- **TypeScript (strict mode)**
- **Vite** for dev and build
- **Canvas API** for rendering (no game framework yet — Phaser later if animation/audio needs justify it)
- **Vitest** for tests
- **No state-management library** — the engine *is* the state management

The engine must remain framework-free; only the renderer layer touches DOM/Canvas. The renderer subscribes to engine state changes through a simple event emitter pattern.

---

## Architecture

```
src/
  engine/
    core/
      types.ts         // GameState, Unit, Tile, Action, etc.
      reducer.ts       // (state, action) => state
      validators.ts    // isLegalAction(state, action) → boolean
    systems/
      pathfinding.ts   // Dijkstra with movement-class-aware terrain costs
      combat.ts        // damage calculation, counterattack resolution
      capture.ts       // capture progress and ownership transfer
      economy.ts       // income, unit costs, build legality
      win.ts           // HQ capture or rout check
    queries/
      selectors.ts     // derived data (reachable tiles, attackable targets, ...)
    ai/
      types.ts         // AI interface
      random.ts        // Random AI (for engine testing only)
      utility.ts       // Tier 1 utility-scoring AI
      threatMap.ts     // Tier 2 threat/value precomputation
      roles.ts         // Tier 3 role assignment
  data/
    units.json
    terrain.json
    damage.json
    ai-weights.json
    maps/
      duel.json
      crossroads.json
  renderer/
    canvas.ts          // grid + sprite rendering
    input.ts           // mouse → action mapping
    hud.ts             // funds, turn, end-turn button, build menu
    animations.ts      // animation queue
  main.ts
tests/
  reducer.test.ts
  pathfinding.test.ts
  combat.test.ts
  ai.test.ts
```

**Hard rule:** the engine never imports from `/renderer` or `/ui`. One-way dependency. Sanity check: delete `/renderer` and verify the engine still compiles and its tests pass.

---

## Core Types

These anchor everything. Put them in `engine/core/types.ts`:

```ts
export type PlayerId = 0 | 1;
export type UnitId = string;
export type Coord = { x: number; y: number };

export type MovementClass = 'foot' | 'wheel' | 'tread' | 'air' | 'sea';
export type UnitType = 'infantry' | 'recon' | 'tank' | 'artillery' | 'copter';

export type TerrainType =
  | 'plain' | 'road' | 'forest' | 'mountain'
  | 'sea' | 'city' | 'hq' | 'factory';

export type Unit = {
  id: UnitId;
  type: UnitType;
  owner: PlayerId;
  pos: Coord;
  hp: number;              // 0–100, displayed as 1–10
  hasMoved: boolean;
  hasActed: boolean;
  captureProgress: number; // 0–20, accumulates on capturable tile
};

export type Tile = {
  terrain: TerrainType;
  owner: PlayerId | null;  // for capturable tiles
};

export type GameState = {
  turn: number;
  currentPlayer: PlayerId;
  map: Tile[][];
  units: Record<UnitId, Unit>;
  players: Record<PlayerId, { funds: number; hq: Coord }>;
  phase: 'idle' | 'animating';
  winner: PlayerId | null;
};

export type Action =
  | { type: 'MOVE'; unitId: UnitId; path: Coord[] }
  | { type: 'ATTACK'; attackerId: UnitId; targetId: UnitId }
  | { type: 'CAPTURE'; unitId: UnitId }
  | { type: 'BUILD'; at: Coord; unitType: UnitType; owner: PlayerId }
  | { type: 'WAIT'; unitId: UnitId }      // end unit's turn without action
  | { type: 'END_TURN' };
```

---

## Phase-by-Phase Plan

### Phase 0 — Scaffolding

Vite + TypeScript strict + Vitest. ESLint with `@typescript-eslint/recommended`. Folder structure as above with placeholder index files.

**Acceptance:** empty Canvas renders, `npm test` runs (no tests yet, exits clean), `npm run build` succeeds.

### Phase 1 — Engine MVP

Implement core types, the reducer, validators, pathfinding (Dijkstra weighted by movement class × terrain cost), combat, capture, win check.

**Damage formula:**

```ts
const damage = Math.floor(
  baseDamagePercent
  * (attackerHp / 100)
  * (1 - 0.1 * defenseStars * (defenderHp / 100))
);
```

**Capture:** an infantry on a capturable tile uses CAPTURE, accumulating `floor(hp / 10)` progress per turn. At 20+, tile flips ownership and progress resets. Moving off a capturable tile resets progress to 0.

**Counterattack:** if defender survives an attack and is in range (not artillery indirect), defender attacks back using the same formula with its now-reduced HP. Counterattacks themselves do not trigger further counterattacks.

**End-of-turn processing:** reset all current-player units' `hasMoved`/`hasActed` to false, grant income (count of owned cities × 1000 funds, HQ counts as a city for income), increment turn, swap currentPlayer, check win.

**Acceptance:** Vitest covers happy-path movement, blocked movement (terrain ∞, occupied tile, edge), capture flip, kill resolution, counterattack resolution, HQ capture win, rout win. No renderer involved.

### Phase 2 — Data

Author JSON content. Use these tables as starting values — they are knobs, not commandments.

**Unit roster:**

| Type | Cost | Move | Class | Range | Notes |
|---|---|---|---|---|---|
| infantry | 1000 | 3 | foot | 1 | only unit that can capture |
| recon | 4000 | 8 | wheel | 1 | high move, weak armour |
| tank | 7000 | 6 | tread | 1 | core damage dealer |
| artillery | 6000 | 5 | tread | 2–3 | indirect; can't counter; can't move and attack same turn |
| copter | 9000 | 6 | air | 1 | ignores ground terrain movement costs |

**Terrain table** (defence stars + movement cost per class; ∞ = impassable):

| Terrain | Def | Foot | Wheel | Tread | Air | Sea |
|---|---|---|---|---|---|---|
| plain | 1 | 1 | 2 | 1 | 1 | ∞ |
| road | 0 | 1 | 1 | 1 | 1 | ∞ |
| forest | 2 | 1 | 3 | 2 | 1 | ∞ |
| mountain | 4 | 2 | ∞ | ∞ | 1 | ∞ |
| sea | 0 | ∞ | ∞ | ∞ | 1 | 1 |
| city | 3 | 1 | 1 | 1 | 1 | ∞ |
| hq | 4 | 1 | 1 | 1 | 1 | ∞ |
| factory | 3 | 1 | 1 | 1 | 1 | ∞ |

**Damage table** (attacker row → defender column, base damage %):

|  | inf | rec | tnk | art | cop |
|---|---|---|---|---|---|
| infantry | 55 | 12 | 5 | 15 | 7 |
| recon | 75 | 35 | 10 | 35 | 55 |
| tank | 75 | 85 | 55 | 70 | 65 |
| artillery | 90 | 80 | 70 | 75 | 65 |
| copter | 75 | 55 | 25 | 65 | 65 |

**Maps** as JSON: a 2D grid of terrain symbols plus a `units` array of starting positions and a `players` block with HQ coords. Starter `duel.json` is 12×8 with two HQs, four neutral cities, one factory per player, and a central forest belt. Build a small loader that validates and converts to `Tile[][]`.

**Acceptance:** data files load, schema-validate, and the engine can run an AI-vs-AI match end-to-end using only this data.

### Phase 3 — Renderer & input

Canvas grid. Tiles 48px on desktop, 32px on mobile (responsive via viewport). Units as coloured squares with type letter overlay — sprites later. Movement range highlight blue (overlay alpha 0.3), attack range red, selected unit yellow border, capturable tiles owned by current player faintly highlighted.

**Input flow:** click own unit → select, show movement range. Click in-range tile → preview path; click again to commit MOVE. After move (or on selection if `hasMoved` true), action menu appears: Attack / Capture / Wait. Click enemy in attack range → preview `{ dealt, received }` damage as floating tooltip; click again to confirm ATTACK. Right-click or Esc anywhere = cancel selection.

End-turn button bottom-right. Build menu opens on click of an owned factory tile when unoccupied. Disable buttons for actions the current funds can't afford.

The renderer subscribes via emitter: engine emits `stateChanged`, renderer redraws. Animations are a separate queue so the renderer can interpolate a unit moving along a path while the underlying state has already updated.

**Acceptance:** two humans can hot-seat a complete match end-to-end. Damage preview matches actual damage dealt within rounding.

### Phase 4 — AI Tier 1

```ts
export type AI = (state: GameState, player: PlayerId) => Action[];
```

Returns the full action sequence for one turn, terminating with `END_TURN`.

Implement two AIs:

**Random AI** — picks legal actions uniformly at random. For engine sanity testing only. Run AI-vs-AI matches headlessly; assert no engine errors and matches always terminate.

**Utility AI** — the real Tier 1. For each owned unit (in some stable order — most-valuable-first works well), enumerate every legal `(destination, follow-up action)` pair reachable this turn. Score each with the weighted utility function below. Pick the best, apply via the reducer, repeat. When no unit has a positive-scored action available, `END_TURN`.

```ts
function scoreAction(state, after, unit, action, weights) {
  return (
      damageDealt(state, after)        * weights.damageDealt
    + captureProgress(state, after)    * weights.capture
    - counterAttackDamage(after, unit) * weights.counterRisk
    - futureThreat(after, unit)        * weights.futureThreat
    + positionalValue(after, unit)     * weights.positional
    + objectiveBonus(after, unit)      * weights.objective
  );
}
```

Default weights in `data/ai-weights.json` to start: `damageDealt 1.0, capture 1.5, counterRisk 0.8, futureThreat 0.5, positional 0.3, objective 0.6`. Tune from playtesting.

**Helper functions:**

- `damageDealt`: sum over each enemy unit of `(hpBefore - hpAfter) × (cost / 1000)`.
- `captureProgress`: +5 if action is CAPTURE and progress flips ownership, +2 if partial, 0 otherwise.
- `counterAttackDamage`: predicted counter damage in HP from this exchange, weighted by attacker's `cost / 1000`.
- `futureThreat`: sum over enemy units of `(max damage they could deal to unit at new position next turn) × (their cost / 1000)`, multiplied by 0.5 (uncertainty discount).
- `positionalValue`: `-manhattanDistance(unit.pos, enemyHq) × 0.1 + tile.defenseStars × 0.5`.
- `objectiveBonus`: +3 if action moves the unit toward its role objective (Phase 5; return 0 here).

**Acceptance:** utility AI beats random AI 10–0 over 10 matches on duel map. AI completes a turn in <200ms on mid-spec hardware.

### Phase 5 — Threat maps and roles

Precompute once at the start of each AI turn:

- **threatMap: `number[][]`** — for each tile, the max single-turn damage an enemy unit could deal there. For each enemy unit, expand its movement range, then for each tile in range, compute max damage it could deal to a representative target on each adjacent (or in-range for indirect) tile. Cache the result.
- **valueMap: `number[][]`** — strategic value per tile: high near enemy HQ, on neutral capturable tiles, on chokepoints (low-degree tiles in the movement graph).

Replace `futureThreat` and `positionalValue` with O(1) map lookups.

**Role assignment:**

```ts
type Role = 'capturer' | 'frontline' | 'support' | 'defender';
```

Assign at turn start from unit type, HP, and proximity to objectives:

- `infantry` close to a neutral or enemy-owned capturable → `capturer`
- `artillery` or HP < 50 → `support` (retreat-biased)
- any unit within 4 tiles of own HQ when threat to HQ is non-zero → `defender`
- otherwise → `frontline`

Roles modify the weights multiplicatively: capturer × {capture: 3, counterRisk: 1.5}, defender × {futureThreat: 3, capture: 0}, support × {counterRisk: 2, futureThreat: 1.5}, frontline ×{damageDealt: 1.2}.

**Acceptance:** Tier 2+3 AI beats Tier 1 AI ≥7/10 over 10 matches on both duel and crossroads maps.

### Phase 6 — Polish (optional v1, definitely v2)

Animation queue with proper move/attack/death easing. Save/load (state is JSON-serialisable — trivial). Replay from action log (free from the reducer architecture — just log actions and re-apply from initial state). Sound. Sprites. More maps. Map editor. Network play.

---

## Out of Scope for v1

Commander powers / COs, day-night, weather, multiplayer networking, real sprite art, sound, dedicated mobile touch UI (responsive layout fine, but mouse-first), AI levels above Tier 3 (no minimax, no MCTS, no RL — explicitly do not attempt), more than two players.

Fog of war shipped behind the `?fog=on` URL param + toolshelf toggle (see
`plans/fog-of-war.md`). Per-unit `visionRange` lives in `src/data/units.json`;
`visibleTiles` and `viewStateForPlayer` in `src/engine/queries/selectors.ts`
do the actual masking. The AI plans against the filtered state when fog is
on; tier3-fog still beats tier1-fog ≥7/10 on duel. Last-known-position
ghosts, forest-hides-ground, and mountain vision bonus are deferred to v1.1.

---

## Testing Discipline

The reducer must be 100% covered. Every action type, every legality check, every system function. The engine is pure, tests are cheap — write them as you go.

AI tests are matchups, run headlessly through Vitest. Utility-vs-random, utility-with-threats-vs-utility-without. The win-rate thresholds in each phase's acceptance section are the test assertions.

Add an `--ai-vs-ai` CLI mode early. Cheapest balance test you'll write — leave it running with different weight files in `data/ai-weights.json` to see which configurations produce balanced/decisive games.

---

## Implementation Notes

- Don't optimise prematurely. The reducer is O(n) over state per action; n is small.
- Immutability via spread / `structuredClone` is fine. Switch to Immer only if perf becomes a real measured problem.
- Keep the AI deterministic given a seed (pass a seeded RNG through, don't use `Math.random` directly). Essential for debugging and balance testing.
- Log every action to console during dev. Replays are free given the architecture.
- Resist adding state-management libraries. The reducer is the state manager; selectors are the derived-state layer; the emitter is the subscription mechanism. That's enough.
- The unit roster, terrain table, damage table, and AI weights are *all* knobs. The point of the engine-first approach is that the game design lives in those JSON files. Tune them.
