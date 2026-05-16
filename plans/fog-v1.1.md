# Plan: Fog of War v1.1

## Context

Fog of war shipped in v1 behind `?fog=on` + the toolshelf toggle. Three
canonical Advance-Wars-style fog rules were deferred and named explicitly
in `PLAN.md`:

> Last-known-position ghosts, forest-hides-ground, and mountain vision
> bonus are deferred to v1.1.

This plan ships all three. Each is independent and committable on its own;
do them in the order below (smallest → largest blast radius).

Acceptance bar:
- All three rules behave correctly under unit tests.
- Tier-3 fog AI still beats Tier-1 fog AI ≥7/10 on `duel` (the v1
  acceptance threshold doesn't regress).
- Visual: fog-on screenshots show ghost markers, forest hides, and
  mountain-extended vision distinctly from baseline fog.
- No regression on the existing `tests/fog-of-war.test.ts` and
  `tests/fog-acceptance.test.ts`.

## Setup

Worktree off `main` per `plans/README.md`:

```sh
git worktree add ../bats-fog-v1.1 -b fog/v1.1
cd ../bats-fog-v1.1
ln -s ../bats/node_modules .
npm test                                           # confirm green
npm run shoot -- --map=duel --url='http://localhost:5179/?map=duel&fog=on' \
  --out=/tmp/fog-baseline.png                      # capture before-state
```

Use `--port=5180` on `shoot` if another instance is on 5179.

## Background reading

Read in this order:

1. `PLAN.md` — the "Out of Scope for v1" paragraph that names the three
   v1.1 rules. This is the contract.
2. `src/engine/queries/selectors.ts` — the entire fog block (lines 12–316).
   In particular `visibleTiles`, `viewStateForPlayer`, `isVisibleTo`,
   `visibleUnitAt`, and the `FOG_HIDDEN_SENTINEL` mechanism. All three
   v1.1 rules extend this file.
3. `src/data/units.json` + `src/engine/data/loader.ts` — `visionRange`
   field on every unit. Mountain bonus may add a `mountainVisionBonus`
   sibling field, OR may be a global constant; decision called out below.
4. `src/data/terrain.json` — terrain stats. Forest/mountain entries are
   the relevant targets.
5. `src/renderer/canvas.ts` — `drawUnits` + `drawFogMask` (lines 364, 671).
   Ghost rendering and forest-hide rendering land here.
6. `tests/fog-of-war.test.ts` — read the "visibleTiles matrix" describe.
   New tests follow the same shape.
7. `tests/fog-acceptance.test.ts` — the AI head-to-head harness; the
   regression check at the end of this plan reuses it.

## Current state

- `visibleTiles(state, player)` returns the union of per-unit vision disks
  (Manhattan radius = `UNITS[type].visionRange`, or `SUBMERGED_VISION_RANGE`
  for dived subs) plus a Manhattan-1 disk around every owned property.
- `viewStateForPlayer(state, player)` clones state, marks every
  out-of-vision enemy unit with `loadedIn = FOG_HIDDEN_SENTINEL`, and
  returns it. The AI plans against this filtered view.
- Submerged-sub stealth is the existing precedent for "tile-visible but
  unit-still-hidden" — the same `viewStateForPlayer` post-filter handles it
  (lines 158–171). Forest-hides-ground will reuse that pattern.
- `GameState.players[p]` currently only stores `{ funds, hq }`. Adding a
  `seenEnemies` field for ghost memory is a state-shape change and
  affects save/load + `tests/save-load.test.ts`. Heads up.
- Renderer reads `visibleTiles(state, viewer)` once per frame to draw the
  fog mask and to filter unit drawing. Ghost rendering threads through
  here.

## Approach

Three layers. Each one tested + committable on its own.

### Layer 1 — Mountain vision bonus (smallest)

A unit standing on a `mountain` tile sees further. Classic AW value is +3
to base vision range.

- Mountain is impassable to `wheel`, `tread`, and `sea` movement classes
  (see `terrain.json`), so in practice this rule fires for `foot` units
  (infantry) and air, but air ignores ground terrain in this engine — we
  keep the bonus mechanically applicable to *any* unit on a mountain
  tile, and let terrain passability gate who can stand there.
- Implementation: in `visibleTiles`, when iterating own units, look up
  `state.map[u.pos.y][u.pos.x].terrain`; if `'mountain'`, use
  `stats.visionRange + MOUNTAIN_VISION_BONUS`. Submerged subs are a
  no-op (they're at sea, can't be on mountain).
- Constant location: a top-of-file `const MOUNTAIN_VISION_BONUS = 3` in
  `selectors.ts`, mirroring `PROPERTY_VISION_RANGE`. Don't add a JSON
  knob unless we need per-unit overrides — keep it tunable in code.

### Layer 2 — Forest hides ground (medium)

A ground unit on a `forest` tile is invisible to enemies UNLESS the enemy
has any unit at Manhattan distance ≤ 1 of the forest tile (the canonical
"adjacent reveal" rule).

- "Ground" = movement class `foot`, `wheel`, `tread`. Air and sea units
  are unaffected — this is consistent with AW (a copter over a forest
  isn't hidden by it).
- This is a *unit*-level mask, not a *tile*-level one — the forest tile
  is still visible (you see the trees), the unit on it is not. So the
  fix lives in `viewStateForPlayer` + `isVisibleTo`, not in
  `visibleTiles`. Same shape as the existing submerged-sub block.
- Implementation in `viewStateForPlayer`: after the visibility-disk
  check, layer:
  ```ts
  if (!hidden && isGroundUnit(u) && terrainAt(state, u.pos) === 'forest') {
    let revealed = false;
    for (const own of ownUnits) {
      if (manhattan(own.pos, u.pos) <= 1) { revealed = true; break; }
    }
    if (!revealed) hidden = true;
  }
  ```
- Mirror the same in `isVisibleTo` for `visibleUnitAt`.
- Renderer: no change — `drawUnits` already filters via
  `visibleTiles(state, viewer)` for the disk and `viewStateForPlayer`
  semantics for the AI. We need the renderer's `drawUnits` to ALSO ask
  `isVisibleTo` (it currently only checks the tile-set). Sub-task.

### Layer 3 — Last-known-position ghosts (largest)

Per-player memory of where each enemy unit was last seen. Renders as a
greyed-out unit marker at the last-seen tile, until the unit is re-spotted
(replace with truth) or its last-seen tile becomes visible AND empty
(prove it moved away → drop the ghost).

**State location.** This is true game state (it survives turn boundaries
and must round-trip through save/load), so it lives on `GameState`, not
in a derived selector cache:

```ts
type SeenEnemy = {
  unitId: UnitId;
  type: UnitType;
  owner: PlayerId;
  pos: Coord;
  hp: number;
  lastSeenTurn: number;
};

GameState.players[p].seenEnemies: Record<UnitId, SeenEnemy>;
```

**Update rule.** At the end of each `END_TURN` step, AND after every
action by player `p`, for each enemy unit currently visible to `p`,
overwrite `players[p].seenEnemies[enemy.id]` with a fresh snapshot. Then,
for each existing ghost: if the ghost's `pos` is in `visibleTiles(state, p)`
AND no unit (visible or otherwise) sits there per truth state, delete it.
Never delete a ghost outside the viewer's vision — that's the whole
point.

When fog is *off*, skip the bookkeeping entirely (this saves
`save-load.test.ts` from having to round-trip ghost data on legacy
saves; the field is `?: ...` and absent unless fog has touched it).

**Rendering.** A ghost is drawn at half opacity with a small "?" or
clock-face badge at the tile. Render after live units, before fog mask.
If a live enemy unit is visible at the same tile (re-spot during the
current viewer's turn), the live render wins.

**AI consumption.** The AI plans against ghosts as threat sources
("the tank I saw last turn at (5,3) is probably still nearby"). Concrete
hook: extend the wrapper that hands `viewStateForPlayer` to the AI so
that ghost entries in `seenEnemies` whose `pos` is currently hidden are
re-injected into the planning state as faded "phantom" units — same
type, owner, hp, and pos as the snapshot — so the existing
`futureThreat` and threat-map code picks them up without per-call-site
plumbing.

A phantom unit must NOT be treated as a kill target by `attackableTargets`
(you can't attack a memory). Two clean options: (a) tag the phantom with
a new `phantom: true` flag and gate `attackableTargets` on it, or (b)
re-use the `loadedIn = FOG_HIDDEN_SENTINEL` trick with a parallel
`PHANTOM_SENTINEL` so existing cargo-skip logic already excludes it. Pick
(b) for symmetry with the existing fog mechanism.

This is a behavioural change for the AI — tournament numbers will shift.
Re-tune in task 6 if the fog-acceptance threshold breaks.

## Locked decisions

1. **Mountain bonus magnitude** — `+3`, single global constant in
   `selectors.ts`. No JSON knob.
2. **AI ghost consumption** — Aggressive: phantoms re-injected via the
   `PHANTOM_SENTINEL` mechanism above.
3. **Ghost staleness** — positive proof only. Ghosts persist until
   re-spotted (replaced) or their tile is observed empty. No time cap.
4. **Ghost glyph** — faded sprite (half opacity), no badge.

## Tasks

1. **Layer 1 — mountain bonus.** Add `tests/fog-of-war.test.ts` cases:
   `infantry on mountain sees +3 farther in every direction`, and a
   `infantry on plain adjacent to mountain unaffected`. Then add
   `MOUNTAIN_VISION_BONUS` + the per-unit terrain check in
   `visibleTiles`. Run fog tests + acceptance. Commit.
2. **Layer 2 — forest hides ground.** Add tests: (a) enemy infantry on
   forest is hidden from observer with no nearby unit; (b) same enemy
   becomes visible when observer has a unit at Manhattan distance 1;
   (c) enemy copter on forest is unaffected (air); (d) `visibleUnitAt`
   mirrors the same masking. Then layer the check into
   `viewStateForPlayer` and `isVisibleTo`. Update `drawUnits` so the
   canvas renderer asks `isVisibleTo` (not just the tile-set) before
   drawing an enemy unit. Commit.
3. **Layer 3a — state shape.** Add `seenEnemies` to
   `players[p]` in `engine/core/types.ts`. Make it optional. Update
   `engine/data/loader.ts` initial-state construction (default `{}` when
   fog is on; omit when fog is off). Add a save/load round-trip case in
   `tests/save-load.test.ts`. Commit.
4. **Layer 3b — bookkeeping.** Add `updateSeenEnemies(state, player)`
   helper in `selectors.ts` (or a new `engine/systems/memory.ts`). Hook
   it into the reducer at end-of-`END_TURN` and after every visibility-
   changing action (MOVE, UNLOAD, SURFACE — anywhere a unit's
   visibility could change). Tests: ghost is recorded when enemy moves
   out of vision; ghost is deleted when last-seen tile becomes visible
   and empty; ghost is replaced by truth on re-spot. Commit.
5. **Layer 3c — rendering.** Extend `drawUnits` to draw ghosts from
   `state.players[viewer].seenEnemies` for entries whose `pos` is NOT
   in `visibleTiles(state, viewer)`. Half-opacity, no badge. Commit.
6. **Layer 3d — AI phantom injection.** Add `PHANTOM_SENTINEL` alongside
   `FOG_HIDDEN_SENTINEL` in `selectors.ts`. Extend `viewStateForPlayer`
   (or a new wrapper used only by the AI driver) to inject ghost
   entries as phantom units when the AI is the consumer. Make sure
   `attackableTargets` skips them (the cargo-skip path already does, by
   the sentinel trick). Tests: AI's threat map at a hidden tile that
   contains a known-recent enemy tank reads non-zero; AI does not
   attempt to ATTACK a phantom. Commit.
7. **Acceptance regression.** Re-run `tests/fog-acceptance.test.ts`
   (tier3-fog vs tier1-fog ≥7/10 on duel). Aggressive ghost consumption
   WILL shift behaviour — if the threshold breaks, re-tune
   `futureThreat` weights and re-run, then file the round in
   `AI_TUNING.md`.
8. **Document.** Append a "Fog v1.1" section to `PLAN.md`'s "Out of
   Scope" paragraph (replace the deferred-list sentence with a "shipped
   in v1.1" sentence). Append open questions / tuning notes to
   `QUESTIONS.md`.

## UI verification

Capture a baseline before any code changes, then a per-layer screenshot:

```sh
# Before any work — baseline:
npm run shoot -- --url='http://localhost:5179/?map=duel&fog=on&turn=8' \
  --out=/tmp/fog-baseline.png

# After Layer 1 — pick a map with mountains in vision range:
npm run shoot -- --url='http://localhost:5179/?map=highlands&fog=on&turn=6' \
  --out=/tmp/fog-mountain.png
# Diff: a unit on a mountain should reveal a much larger disk.

# After Layer 2 — forest belt on duel:
npm run shoot -- --url='http://localhost:5179/?map=duel&fog=on&turn=10' \
  --out=/tmp/fog-forest.png
# Diff: enemy units in the forest belt should be invisible despite the
# tile being lit; if you've placed an own unit adjacent, the enemy reveals.

# After Layer 3 — ghost markers:
npm run shoot -- --url='http://localhost:5179/?map=duel&fog=on&turn=15' \
  --out=/tmp/fog-ghosts.png
# Diff: half-opacity enemy markers at last-seen positions in dimmed
# (out-of-vision) tiles.
```

Open each PNG (Read tool — Claude is multimodal) to confirm the visual
matches intent before committing.

## Acceptance

- New unit tests cover all three rules; existing fog tests still pass.
- `tests/fog-acceptance.test.ts` still hits the ≥7/10 tier3-fog vs
  tier1-fog threshold on `duel`.
- `npm test` is fully green (account for the known perf flake in
  `ai-amphibious` if amphibious has merged by then; otherwise no flakes).
- Screenshots above show the three rules working visually.

## Out of scope

- Time-based ghost decay (no aging without positive disproof in v1.1).
- Per-unit `mountainVisionBonus` overrides in `units.json` (use a single
  global constant; revisit only if balance demands).
- Reveal-on-attack (a unit that fires its weapon revealing itself) — not
  in PLAN.md's deferred list, separate feature.
- Property vision changes (still Manhattan-1 from owned cities/factories;
  no scope change in v1.1).

## Files you will likely touch

- `src/engine/queries/selectors.ts` — `visibleTiles` (Layer 1),
  `viewStateForPlayer` + `isVisibleTo` (Layer 2), `updateSeenEnemies`
  (Layer 3).
- `src/engine/core/types.ts` — `seenEnemies` field on `players[p]`.
- `src/engine/core/reducer.ts` — `updateSeenEnemies` hook on END_TURN
  and visibility-changing actions.
- `src/engine/data/loader.ts` — initial `seenEnemies: {}` when fog is on.
- `src/renderer/canvas.ts` — `drawUnits` ghost rendering + `isVisibleTo`
  call for forest-hides.
- `tests/fog-of-war.test.ts` — extend the existing matrix.
- `tests/save-load.test.ts` — round-trip the new field.
- `PLAN.md`, `QUESTIONS.md` — documentation tail.

Tests to keep passing: everything in `tests/`. The fog-acceptance suite
is the one to watch for behavioural regressions.
