# Plan: Fog of War

## Context

The game currently shows the full board to both players. Recon is a 5-move
cavalry unit with no scouting value because no information is hidden;
submarines exist but their stealth (already implemented) is the only
information-hiding mechanic in the game.

Goal: per-player visibility computed from each player's own units + owned
bases, with hidden tiles rendered as a fog overlay and enemy units invisible
inside the fog. AI plays with imperfect information.

This changes the strategic feel of the game more than any other single
feature. Recon becomes the most cost-efficient unit in the game during the
opening; ambushes become real; the early-game tempo shifts from "race to the
front" to "build the picture, then commit."

## Setup

Do this work in a git worktree, not on `main`. See
[`plans/README.md`](README.md#working-in-a-worktree) for the full setup:

```sh
git worktree add ../bats-fog -b feat/fog-of-war
cd ../bats-fog
ln -s ../bats/node_modules .     # or `npm install` if you change package.json
npm test                         # confirm the worktree builds
```

Use `--port=5180` (or any free port) on `npm run shoot` if another instance
is running on the default 5179.

## Background reading

1. `src/engine/queries/selectors.ts` — `isVisibleTo`, `visibleUnitAt`. The
   submarine stealth check is the model: a predicate `(state, unit, observer)
   → boolean`. Fog generalises this to all units.
2. `src/engine/core/types.ts` — `UnitType`, `TerrainType`. You'll add
   `visionRange` to UnitType and a vision-modifier to certain terrains.
3. `src/data/units.json` — per-unit visionRange data.
4. `src/data/terrain.json` (if it exists, else inline in code) — terrain
   movement table; you may need a hiding-terrain flag for forest.
5. `src/renderer/canvas.ts` + `src/renderer/terrain.ts` — terrain rendering.
   You'll add a fog-mask pass after terrain is drawn.
6. `src/engine/ai/utility.ts` — `scoreAction` uses the full state; under fog,
   the AI must score on what it can see. Find every place where enemy units
   are read; gate those reads through the visibility predicate when the AI
   plays under fog.
7. `src/main.ts` — URL params. You'll add `?fog=on/off` and likely a
   per-player viewer override for hot-seat (`?view=p0/p1` for debugging).

## Current state

- `isVisibleTo(state, unit, observer)` exists but only handles submerged subs.
- No per-player visibility set is computed anywhere.
- Renderer always draws all units; UI assumes omniscience.
- AI reads `state.units` directly without any view filter.
- Tests assume omniscient state (will need a few new fixtures).

## Approach

Treat fog as a layer that wraps the existing state for read paths. The
authoritative state is unchanged; visibility is a computed view per player.

### Data additions

In `src/data/units.json`, add per-type `visionRange`:

| unit | range | rationale |
|------|------:|-----------|
| infantry | 2 | baseline ground |
| recon | 5 | scout role made real |
| tank | 3 | armoured eyes |
| artillery | 2 | hides behind front |
| copter | 5 | air vantage |
| transport | 1 | nearly blind |
| fighter | 5 | high air |
| bomber | 4 | high air, target-focused |
| battleship | 3 | naval gun line |
| cruiser | 5 | naval scout |
| aatank | 2 | ground AA |
| lander | 1 | cargo barge |
| submarine | 5 surfaced / 1 submerged | already stealthed |
| carrier | 4 | airbase eyes |
| (owned base/HQ/city) | 1 | static eyes |

A unit on a *mountain* tile gets +3 vision (AW rule, optional v1 polish).
A *forest* tile hides ground units inside it from observers further than 1
tile (AW rule; defer to v1.1 if you want to keep scope tight).

### Visibility set (selector)

New selector: `visibleTiles(state, player) → Set<string>` where key is
`"x,y"`. Algorithm:
- start empty
- for each owned unit: add every tile within Manhattan ≤ unit's visionRange
  (NOT a true line-of-sight; AW is Manhattan-radius)
- for each owned base/HQ/city/factory: add own tile + 4-neighbours
- return the set

Memoise per turn (clear at END_TURN). On a 20×12 map with 6 units each, this
is cheap.

Extend `isVisibleTo(state, unit, observer)`:
- if unit is friendly to observer → visible
- if submerged sub (existing rule) → unchanged
- else: visible iff unit's pos is in `visibleTiles(state, observer)`

Extend `visibleUnitAt(state, c, viewer)` similarly.

### Renderer

- New overlay pass in `canvas.ts` after terrain + before unit drawing: fill
  hidden tiles with a semi-transparent dark mask (~rgba(0,0,0,0.55)). Tiles
  that are in vision but not currently containing your own unit get a faint
  "explored" tint — half-strength mask — so the player can distinguish
  "never seen" from "seen but currently no eyes there". (Standard fog/snow
  pattern.)
- Enemy units drawn ONLY when their tile is in the viewer's visibleTiles
  set. Re-use the existing `visibleUnitAt` to gate.
- The board still uses the full canvas; only enemy-unit sprites get the
  visibility gate. Terrain is always rendered (you've explored it once
  during scrolling on turn 1).

Decision to call out: do you want **permanent terrain exploration** (once
revealed, always shown), or **dynamic fog** (terrain re-fogs when no eyes
are present)? AW uses dynamic-with-explored-memory; recommend matching that
for consistency. You'll need a per-player "ever-seen" tile set.

### Hot-seat view

Single-screen hot-seat means the viewer must match the current player. Two
options:
- **Auto-switch**: viewer = `state.currentPlayer`. Each END_TURN swaps the
  visible mask. Simple, but spoils info during the swap animation.
- **Manual confirm**: a "pass device" interstitial after END_TURN. Tedious
  for hot-seat-with-AI which is the common case.

Recommend: auto-switch with a quick fade animation; gate it behind a
`?private-mode=1` flag if you want the confirm interstitial later.

### AI under fog

This is the load-bearing change for AI competence.

- Replace direct `state.units` reads in scoring with a view that filters via
  `visibleUnitAt(state, c, ai.player)`.
- Threat map (`src/engine/ai/threatMap.ts`) currently sums damage from all
  enemy units; under fog, sum only from visible enemy units. Add a
  "phantom-threat" term for never-seen tiles in your half of the board to
  represent uncertainty.
- Build policy doesn't need to change.
- Determinism: with the same seed AND same visibility-info, the AI must
  still pick the same actions. Test this; visibility is a function of state
  so it's already deterministic.

### Optional polish (v1.1)

- "Last-known-position ghosts": render a faded sprite at the last visible
  position of an enemy unit that left view. Adds *enormous* strategic feel
  for almost no code.
- Forest hiding rule (ground units in forest invisible from >1 away).
- Mountain +3 vision bonus.

## Tasks

1. **Data.** Add `visionRange` to all 14 unit types in `src/data/units.json`
   and to the `UnitStats` type in `src/engine/core/types.ts`.
2. **Selector.** Implement `visibleTiles(state, player)` in
   `src/engine/queries/selectors.ts`. Memoise (key on state.turn + player).
   Extend `isVisibleTo` and `visibleUnitAt` to use it. Tests:
   - infantry sees Manhattan-2 radius
   - recon sees Manhattan-5
   - owned city contributes 4-neighbour vision
   - friendlies always visible
   - enemy in fog → not visible
3. **Renderer.** Add fog-mask pass + enemy-visibility gate. Update sprite
   draw loop. Smoke test: `npm run shoot -- --map=duel --fog=on --out=...`
   to confirm dark mask appears outside player 0's vision.
4. **URL param.** Add `?fog=on/off` to `main.ts`. Default off (don't break
   existing replays / saves).
5. **Viewer state.** Track viewer = `state.currentPlayer` by default;
   allow `?view=p0|p1` override for testing.
6. **AI integration.** Audit `utility.ts` and `threatMap.ts`. Filter enemy
   reads through visibility when fog is on. Add phantom-threat term. Run
   round-robin tournament with `?fog=on`; confirm AI still wins ≥ 7/10
   matches in the seed range used by `ai-tier3-vs-tier1.test.ts`.
7. **Determinism test.** Add a test that asserts a fog game with seed S
   produces the same trace on two runs (same player moves are identical).
8. **UI toggle.** Add a "Fog: on/off" toggle in the chrome toolshelf
   (next to Map / Sound). On change, reload with the new `?fog=` param.
9. **Document.** Update `PLAN.md` and `AI_TUNING.md` with the new
   acceptance numbers. Note open questions in `QUESTIONS.md`.

## UI verification

Use the screenshot tool to see the fog mask in action:

```sh
# Player 0's view at game start on duel — most of the map should be dark.
npm run shoot -- --map=duel --url='http://localhost:5179/?map=duel&fog=on&view=p0' \
  --out=/tmp/fog-p0-start.png

# After a few turns of scouting with recon:
npm run shoot -- --map=duel --p0=aggressor --p1=balanced --turn=4 \
  --url='http://localhost:5179/?map=duel&fog=on&view=p0&p0=aggressor&p1=balanced' \
  --out=/tmp/fog-p0-t4.png

# Highlands (air-heavy) — fighters should clear large radii:
npm run shoot -- --url='http://localhost:5179/?map=highlands&fog=on&view=p0&p0=balanced&p1=turtle' \
  --turn=6 --out=/tmp/fog-highlands.png
```

Look for:
- Hard contrast between visible (clear) and hidden (dim) tiles
- "Explored" tiles (lighter dim) vs "never seen" (full dim) if you implement
  the optional ever-seen memory
- Enemy units invisible outside vision
- No flicker on END_TURN view-swap (or, if you keep it, an intentional fade)

## Acceptance

- Toggle works; default off matches current behaviour exactly.
- With `?fog=on`, hidden tiles render dim; enemy units in fog absent from
  sprite draws.
- AI plays a full game under fog without crashing and wins the duel tier3
  vs tier1 acceptance test (≥ 7/10).
- All 367 non-perf tests still pass.
- New visibility-selector tests cover the matrix in the table above.

## Out of scope (v1)

- Line-of-sight (we use Manhattan radius like AW, not raycast).
- Stealth units beyond submarine (no infiltrator class in v1).
- Network spectator mode (single-screen only).
- Last-known-position ghosts (deferred to v1.1).
- Forest-hides-ground rule (deferred to v1.1).
- Mountain vision bonus (deferred to v1.1).

## Files you will likely touch

- `src/data/units.json` — visionRange
- `src/engine/core/types.ts` — UnitStats.visionRange field
- `src/engine/queries/selectors.ts` — visibleTiles + extended predicates
- `src/engine/ai/utility.ts`, `src/engine/ai/threatMap.ts` — view-filter
- `src/renderer/canvas.ts` — fog mask pass + enemy gate
- `src/main.ts` — `?fog=on`, `?view=...` params
- `src/renderer/chrome.ts` — toolshelf toggle
- `tests/fog-of-war.test.ts` — new file
- `AI_TUNING.md`, `PLAN.md`, `QUESTIONS.md` — documentation tail
