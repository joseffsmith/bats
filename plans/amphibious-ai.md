# Plan: Amphibious AI

## Context

The game ships with transports, landers, carriers, and submarines, plus naval
maps (`armada`, `island_hop`) designed around them. The AI builds these units
but never uses them — round-6 tuning shows `armada` and `island_hop` finish as
6/6 stalemates because the AI candidate generator only emits MOVE / ATTACK /
CAPTURE / WAIT / BUILD, never LOAD / UNLOAD / DIVE / SURFACE. Result: a transport
sits idle next to an infantry that can't cross water.

Goal: make the AI use the amphibious roster competently enough that armada and
island_hop become contested games, and submarines see use as a stealth/recon
asset on any sea-bearing map.

Acceptance bar: armada + island_hop stalemate rate drops below 50% (from 100%);
overall round-robin stalemate rate stays at or below the post-tuning baseline
(currently 50%); no regression on land-only maps.

## Background reading

Read in this order:
1. `src/engine/ai/candidates.ts` — candidate generator. Look at `generateCandidates`
   and `yieldFollowUps`. New action enumeration goes here.
2. `src/engine/ai/utility.ts` — scoring. Find `scoreAction`. Each action type has
   a branch; you'll add LOAD/UNLOAD/DIVE/SURFACE branches.
3. `src/engine/ai/personas.ts` + `src/data/ai-personas.json` — per-persona weights.
   The `buildPolicy.preferred` and `buildPolicy.avoid` lists currently exclude the
   amphibious units for most personas; that's a deliberate avoidance because the
   AI can't operate them. Loosen this only after the operating code works.
4. `src/engine/core/validators.ts` — `checkLoad`, `checkUnload`, `checkDive`,
   `checkSurface`. These tell you what's legal; the candidate generator must
   only emit candidates that pass these.
5. `src/engine/core/reducer.ts` — `applyLoad`, `applyUnload`, `applyDive`,
   `applySurface`. Understand the side-effects (cargo.pos tracking, transport
   action consumption on unload, etc.).
6. `src/engine/queries/selectors.ts` — `isVisibleTo`, `visibleUnitAt`. Submerged
   subs are hidden from observers without an adjacent sub/cruiser. Relevant to
   DIVE scoring.
7. `AI_TUNING.md` round 6 — what changed last time and the perf budgets to
   respect.
8. `QUESTIONS.md` Phase 7 round 6 — open questions about transport pathing and
   priorities.

## Current state

- 14 unit types in `src/data/units.json`. Cargo capacity + `cargoMovementClasses`
  fields exist on the four carrier types.
- `cargo?: UnitId[]` on transport unit + `loadedIn?: UnitId` on cargo unit.
- Engine actions LOAD / UNLOAD / DIVE / SURFACE fully implemented and tested
  (see `tests/carrier.test.ts`, `tests/submarine.test.ts`).
- UI exposes LOAD/UNLOAD via the action menu; player can drive amphibious play
  manually.
- AI: zero awareness of these actions. Candidate generator filters by movement
  class so ground units pathfind around water (no swimming), but no cargo plan.

## Approach

Build it in three layers. Each layer must be tested and committable on its own.

### Layer 1 — Submarine DIVE / SURFACE (smallest)

DIVE/SURFACE are single-unit toggle actions with no target geometry. Easiest
on-ramp.

- Enumerate: for any owned submarine with `!hasActed`, emit DIVE candidate
  when surfaced and a SURFACE candidate when submerged.
- Score DIVE: high when at least one visible enemy could attack the sub next
  turn AND no friendly sub/cruiser would un-mask it for the enemy. Negative
  small constant otherwise (don't dive just because you can).
- Score SURFACE: high when ≥1 enemy in attack range AND no enemy sub/cruiser
  adjacent. Otherwise low (staying hidden has value).
- Persona: aggressor + balanced get full weight; turtle/economist get half.

### Layer 2 — Transport / lander operations

The interesting layer. The AI must understand "load this infantry → ferry to
that shore → unload → capture / attack."

Enumeration scheme (kept tight — combinatorics get bad fast):

- **LOAD candidates:** for each friendly transport-class unit T with capacity
  remaining and `!hasActed`:
  - For each friendly cargo-class unit C that fits T's `cargoMovementClasses`
    and can reach T's tile this turn (use existing path-finder on the cargo's
    own movement class, allow stopping on T):
    - Emit `LOAD { transportId: T.id, cargoId: C.id, path: pathTo(T) }`
  - Cap at the top-K cargo candidates by distance-to-front (use `threatMap`)
    to bound the branching factor. K=3 is a good starting point.

- **UNLOAD candidates:** for each friendly transport T with cargo and
  `!hasActed`:
  - First, enumerate where T could move this turn (reuse MOVE enumeration).
  - For each candidate (or "stay put"), for each cargo C in T.cargo:
    - For each 4-neighbour tile D of T's would-be position that's
      a) in-bounds, b) unoccupied, c) passable for C's movement class:
      - Emit `UNLOAD { transportId, cargoId, destination: D }` and a follow-up
        capture/attack for C from D when applicable.
  - Score by:
    - capturable tile at D = high (especially HQ)
    - new front line distance reduced
    - landing under enemy threat = penalty proportional to expected damage to C

- **MOVE-then-UNLOAD chains:** the candidate generator already supports
  MOVE + follow-up; extend the follow-up enumerator so an `UNLOAD` follow-up is
  considered after the transport's MOVE.

### Layer 3 — Carrier loops

Carrier carries air units. Same shape as transport, but the cargo class is
`air`, not `ground`. Reuse layer-2 code; the only new logic is that air units
LOAD onto a carrier mid-sea (so the carrier becomes a forward refuel/airstrip).

Optional scoring extension: prefer loading damaged air units (fuel/repair
model isn't implemented in v1, but loading a low-HP fighter still keeps it
alive — UNLOAD next turn from a forward position).

## Tasks

1. **Layer 1.** Write `tests/ai-amphibious.test.ts` first — assert that the
   candidate generator yields DIVE for a surfaced sub adjacent to an enemy
   battleship, and SURFACE for a submerged sub adjacent to a damaged target.
2. Implement DIVE/SURFACE enumeration in `candidates.ts`. Implement scoring
   branches in `utility.ts`. Make tests pass.
3. **Layer 2 LOAD.** Test: a friendly infantry adjacent to a friendly transport
   should produce a LOAD candidate. Then implement enumeration + scoring.
4. **Layer 2 UNLOAD.** Test: a transport carrying infantry within move-range of
   an enemy-owned city should produce an UNLOAD candidate that places the
   infantry on/adjacent to that city. Implement.
5. **Layer 2 MOVE+UNLOAD chain.** Extend `yieldFollowUps`.
6. **Layer 3.** Test that an air unit adjacent to a carrier yields LOAD; that
   a carrier with loaded fighter yields UNLOAD to a tile within fighter range
   of an enemy.
7. **Persona tuning.** Remove `lander`, `transport`, `carrier`, `submarine`
   from the `avoid` lists in personas that should use them now. Use
   `tournament` CLI on `armada` to find the right `preferred` ordering.
8. **Round-robin regression.** Run the full 6×6 pair × map tournament. Confirm:
   - armada stalemate rate < 50%
   - island_hop stalemate rate < 50%
   - all pair win-rates ≥ 10%
   - no land-only map regressed
9. **Document.** Append a "round 7" section to `AI_TUNING.md` summarising what
   changed and the new tournament numbers. Append open questions to
   `QUESTIONS.md`.

## UI verification

Use the screenshot tool to confirm the AI actually moves cargo around:

```sh
# Mid-game state on armada with two AI personas. Step ~12 turns to see
# whether transports have moved cross-water and unloaded infantry on the
# enemy island.
npm run shoot -- --map=armada --p0=balanced --p1=aggressor --turn=12 \
  --out=/tmp/armada-mid.png

# Same for island_hop:
npm run shoot -- --map=island_hop --p0=aggressor --p1=balanced --turn=15 \
  --out=/tmp/island-mid.png
```

Open the PNGs (Claude can Read them; humans use any image viewer). Look for:
- transports/landers off their starting tile, ideally near the enemy coast
- infantry placed on previously-unreachable islands
- the city counter actually moving for both players

If after 12-15 turns the units are still huddled at home, scoring weights for
UNLOAD are too low — bump `objective` weight and re-shoot.

## Out of scope

- Multi-turn LOAD planning (where the AI builds toward a future cargo run). v1
  reactively loads when ready.
- Lander → multiple drops in one turn. v1 unloads one passenger at a time.
- Air refueling / fuel model (not implemented in the engine).
- Pathfinding through enemy ZoC (no ZoC in this game).

## Files you will likely touch

- `src/engine/ai/candidates.ts` — new enumeration cases
- `src/engine/ai/utility.ts` — new scoring branches
- `src/engine/ai/personas.ts` (only if you add new role weights for "ferrier")
- `src/data/ai-personas.json` — preferred/avoid lists, infantryFloor tuning
- `tests/ai-amphibious.test.ts` — new file
- `AI_TUNING.md`, `QUESTIONS.md` — documentation tail

Tests to keep passing: everything in `tests/` (367/368 currently — the 368th is
a perf flake, ignore it unless your changes regress turn time).
