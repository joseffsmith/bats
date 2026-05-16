# Plan: Visual Polish — Pixel Art + Juice

## Context

The game plays well but looks placeholder. Procedural primitives carry the
unit and terrain art; animations exist but lack the small feedback layers
(projectile arcs, muzzle flash, impact dust, hit pause, damage numbers,
idle motion) that make a tactics game feel responsive. We're staying on
plain Canvas API — no Phaser, no Pixi, no WebGL — but committing to a
proper pixel-art asset set plus a juice pass across the renderer.

Goal: make the game look like a deliberate pixel-art tactics title, with
each action producing clear visual feedback, while keeping the engine
untouched and the bundle under budget.

**Acceptance bar:** side-by-side `npm run shoot` screenshots against
`main` show a clearly distinct visual upgrade across units, terrain, and
combat feedback. Bundle stays under 250 KB gzipped. All existing tests
still pass. `delete src/renderer && tsc` still succeeds (the engine-purity
invariant from PLAN.md).

## Setup

Do this work in a git worktree, not on the parent branch. See
[`plans/README.md`](README.md#working-in-a-worktree):

```sh
git worktree add ../bats-polish -b ui/visual-polish
cd ../bats-polish
ln -s ../bats/node_modules .
npm test                         # confirm the worktree builds
npm run dev                      # eyeball the baseline before touching anything
```

Take a baseline screenshot set before you start so the diff is visible:

```sh
npm run shoot -- --map=duel --turn=0  --out=/tmp/baseline-duel-start.png
npm run shoot -- --map=duel --p0=balanced --p1=balanced --turn=14 --out=/tmp/baseline-duel-mid.png
npm run shoot -- --map=armada --turn=0 --out=/tmp/baseline-armada-start.png
npm run shoot -- --map=crossroads --p0=balanced --p1=balanced --turn=10 --out=/tmp/baseline-crossroads-mid.png
```

## Background reading

Read in this order:

1. `PLAN.md` — re-skim the **Architecture** and **Phase 6 — Polish** sections.
   The engine-purity hard rule (`delete /renderer` must compile) is the
   firmest constraint on this plan.
2. `src/renderer/canvas.ts` — main draw loop. `drawScene`, `drawUnit`,
   `drawOverlay`. This is the orchestration layer; sprite + terrain
   modules are called from here. Read in full.
3. `src/renderer/sprites.ts` — current procedural sprite cache. Note the
   `SpriteCache` interface (the public boundary) and the per-unit `paint*`
   helpers (the internals we're replacing).
4. `src/renderer/terrain.ts` — current procedural tile painters and the
   deterministic per-tile hash. Note the `drawTerrain(ctx, state, vp)`
   entry point — keep this stable.
5. `src/renderer/animations.ts` — the queue and anim kinds (move, attack,
   death, hpTween, shake). We're adding kinds, not changing the queue
   shape.
6. `src/renderer/canvas-palette.ts` — player palette constants. The
   palette-swap layer for unit sprites reads from here.
7. `src/renderer/easing.ts` — `easeInOutCubic`, `easeOutBack`. Add new
   easing functions here as needed.
8. `src/main.ts` — startup wiring. The asset loader goes here, before the
   first `render()` call.
9. `scripts/shoot.ts` — how the agent inspects the UI. Add new scenes here.
10. `tests/sprites.test.ts`, `tests/terrain.test.ts`, `tests/animations.test.ts`,
    `tests/canvas-render.test.ts` (if present) — what passes today; what
    needs a JSDOM-safe stub after the rewrite.
11. `index.html` — confirm there's nowhere to inject a loading screen
    today; we'll add a minimal one.

## Current state

What's already wired and should stay:

- **Sprite cache shape.** `createSpriteCache()` returns a `SpriteCache`
  with `get(type, owner, variant)` → `CanvasImageSource`. `canvas.ts`
  calls `drawImage` against the result. The interface survives the
  rewrite; only the bake step changes.
- **Animation queue.** `enqueue*` helpers exist for move, attack, death,
  hpTween, shake. They run serially with `busy()` for input locking.
  We add new kinds; we don't refactor the queue.
- **Death particles.** Already deterministic via injected RNG. Good
  template for the projectile, muzzle-flash, impact, and capture-flash
  systems we're adding.
- **Camera shake.** Already triggered on damage > 40 HP. We tune the
  threshold + magnitude tables but keep the mechanism.
- **HP tween.** Bar slides over 200ms; keep.
- **HUD chrome.** DOM-based in `chrome.ts`. **Out of scope** for this
  plan — visual polish here is canvas-only.
- **Audio module.** Five effects, all procedural WebAudio. We may add
  one or two effect variants for new juice elements (artillery whistle,
  capture chime) but no audio redesign.
- **Test harness.** JSDOM, with canvas methods stubbed. Any new code
  path that hits canvas APIs must degrade gracefully when the stubs are
  active. Pattern: feature-detect the API, no-op if missing.

## Approach

Four work-streams, executed in order. Each one ends in a committable,
screenshot-verifiable state.

### 1. Asset pipeline

Vite handles PNG imports out of the box: `import url from './foo.png'`
gives you a URL the browser fetches. We use this directly — no inlining,
no base64, no bundler config.

- All art lives under `src/renderer/assets/`.
- A small `AssetLoader` module exposes `loadAssets(): Promise<Assets>`
  which kicks off all image fetches in parallel and returns when every
  sheet has decoded. Resolves to a typed `Assets` object with
  `unitsSheet`, `terrainSheet`, `fxSheet` (each is an `HTMLImageElement`
  or `ImageBitmap`).
- `main.ts` calls `loadAssets()` before the first render. A trivial
  loading screen (CSS-only div in `index.html`, hidden once the promise
  resolves) covers the gap.
- For tests under JSDOM: `loadAssets` detects the absence of
  `HTMLImageElement.prototype.decode` (or equivalent) and returns a stub
  `Assets` whose sheets are 1×1 transparent canvases. The sprite/terrain
  modules' `draw*` calls still execute (`drawImage` is stubbed in JSDOM
  to a no-op), so test coverage is preserved without rendering anything
  meaningful.

**Asset authorship is out of scope for the implementing agent.** Pixel
art will not be drawn by Claude. The plan assumes three sheets land in
`src/renderer/assets/` from one of:

- (a) the user authors them in Aseprite / Pyxel / similar,
- (b) they're sourced from a permissively-licensed pack (e.g. Kenney,
  itch.io free tactics packs — confirm licence per asset),
- (c) they're commissioned.

To unblock implementation while real art is being prepared, **task 0
generates placeholder sheets from the current procedural code** — a
one-shot Node script that paints every sprite + terrain tile into a
single PNG and writes it to `src/renderer/assets/`. The rest of the
plan can be built and tested against the placeholder; swapping in real
art at the end is a file-replace + a sheet-coordinates update.

**Sheet layouts** (frozen — the loader, slicer, and authoring guide all
depend on these):

- `units.png` — 32×32 cells. 14 rows (one per unit type, in roster
  order). 6 columns: `idle1, idle2, idle3, idle4, damaged1, damaged2`.
  Total 192×448 px. Player colour is applied at bake time via palette
  swap on a single reserved "team accent" colour (a hard magenta —
  `#ff00ff` — so the swap is unambiguous).
- `terrain.png` — 32×32 cells. One row per terrain type (8 rows), with
  16 columns covering the 4-bit autotile signatures plus a few extras
  (variant tiles, road junctions). Total 512×256 px. Capturable tiles
  (city/hq/factory) get a dedicated column block for ownership-tinted
  variants; ownership is also rendered as a small canvas-drawn LED on
  top (re-using the existing `terrain.ts` LED code).
- `fx.png` — 32×32 cells. Rows for: muzzle-flash (4 frames),
  small-impact (6 frames), big-impact (6 frames), dust-puff (4 frames),
  capture-pulse (6 frames), idle-bob highlights are runtime — not on
  the sheet. Total 192×160 px.

Tight, hand-authored sheets at 32px keep the asset set small (well
under 100 KB combined PNG) and the slicing code dead simple. Scaling to
the desktop 48px tile is done by the canvas at draw time —
`imageSmoothingEnabled=false` gives crisp nearest-neighbour scaling
that preserves the pixel-art aesthetic.

### 2. Unit sprites

Replace `sprites.ts` internals while preserving the `SpriteCache`
interface.

- Slice `units.png` into per-(type, owner, variant) `OffscreenCanvas`
  entries at startup, mirroring the current bake step. Each entry holds
  all 4 idle frames laid out horizontally on a 128×32 strip; the draw
  loop selects the right frame based on `(performance.now() + hash) %
  cycleMs`.
- Palette swap: for each owner, replace the magenta accent pixels with
  the player's primary colour (`PLAYER_COLOURS[owner].fill`) at bake
  time. One-pass `getImageData`/`putImageData` keyed off the exact RGB
  match. Bake happens once at startup, not per frame.
- Damaged variant: same as today, swap to columns 5–6 when `hp < 50`.
  Keep the existing threshold.
- Add a tiny `spriteOffset(unitId)` returning `{dx: 0, dy: <bob>}` where
  bob is a 1-pixel sine wave, period 1.6s, phase from a hash of
  `unitId`. Called from the draw loop, not the anim queue. Skip the bob
  while the unit is mid-MOVE animation.

### 3. Terrain

Replace `terrain.ts` painters with a sheet-slicer + autotile lookup.
Keep `drawTerrain(ctx, state, vp)` as the only exported function.

- **Autotile signature.** For each tile, look at the four cardinal
  neighbours of the same terrain class (treat "same class" as: forest
  matches forest, sea matches sea + matches map-edge for coast
  continuity, road matches road, mountain matches mountain; plain and
  capturables don't autotile). Produce a 4-bit signature `N|E|S|W` →
  column index 0–15 on that terrain's row in `terrain.png`.
- **Variant tiles.** For terrain types with multiple base tiles
  (plains, sea, forest interior), pick a variant deterministically from
  the coord hash so the map looks organic but doesn't flicker.
- **Capturable ownership.** Read the variant column block (3 owner
  tints: neutral, p0, p1) for city/hq/factory. The LED dot stays as a
  canvas overlay so we don't need 3× the sheet area.
- **Ambient layer** (runtime, no extra sheet cells):
  - Water shimmer: every sea tile gets a 0.5 Hz two-frame swap (the
    second frame is the same tile XOR a stored "glint mask"). Frame
    selection is `(now * 0.5 + coordHash) % 2`.
  - Tree sway: forest tiles offset their draw by ±1px horizontally at
    0.3 Hz, phase from coordHash. No extra sheet art needed.
  - Factory smoke: each owned factory tile emits a particle every ~250 ms,
    drifting up over 800ms with alpha fade. Owner-tinted.
- **Road junctions.** Use the same 4-bit autotile signature; sheet must
  include the 16 variants. The current procedural road already
  computes this — port the logic, point it at the sheet.

### 4. Juice

All juice elements are new `Anim` kinds (or new draw-loop overlays for
the continuous ones). Each is independent and can be enabled / disabled
with a single flag during dev.

- **Projectile.** New `ProjectileAnim` kind. For direct-fire units:
  short tracer line (~80ms, easeOutQuad) between attacker and target
  centres. For artillery: parabolic arc (`y = lerp(a, b, t) - sin(πt) ·
  height`), 300ms duration, with a whistle audio cue. Existing
  `AttackAnim` enqueues a `ProjectileAnim` ahead of itself; the attack
  flash + damage + counterattack chain remains synchronous after the
  projectile lands.
- **Muzzle flash.** New `MuzzleFlashAnim`. Plays the `fx.png`
  muzzle-flash row on the attacker's tile, 4 frames over 80ms, in the
  direction of the target. Triggered alongside the projectile launch.
- **Impact.** New `ImpactAnim`. Plays the small or big impact row from
  `fx.png` on the defender's tile, 6 frames over 200ms. Big impact
  threshold: damage > 30 HP. Triggered when the projectile lands.
- **Hit pause.** New `HitPauseAnim`. When damage > 30 HP, the anim
  queue freezes for 80ms before resuming. Implement as a sentinel anim
  that returns `busy()=true` until its duration elapses — no other
  anims advance during it. Gives the player a beat to register the hit.
- **Damage numbers.** New `DamageLabelAnim`. Floating text (e.g.
  "-35") spawned at the defender's tile, rising 16px over 600ms while
  fading from α=1 to α=0. Crit-style colour for >50, normal for
  ≤50. Pure canvas text — no DOM. Multiple labels can stack (offset
  horizontally by spawn order).
- **Capture flash.** New `CaptureFlashAnim`. When tile ownership flips
  (the reducer emits `CAPTURE`), spawn a 500ms radial pulse from the
  tile centre, tinted to the new owner's colour. The terrain ownership
  tint switches at the midpoint of the flash so the transition feels
  intentional.
- **Idle bob.** Continuous, draw-loop only. Covered in §2.
- **Selection ring.** Replace the current static yellow border with an
  animated dashed circle: 4 dashes, rotating at 30°/s. Subtle, but
  reads as "active selection".
- **Vignette + colour grade.** Lightweight global overlay after the
  scene draw: a radial dark gradient at 5% alpha at the corners, and a
  per-map colour-grade matrix (e.g. duel = neutral, armada = cooler
  blue, canyon = warmer red). Implemented as one `globalCompositeOperation
  = 'multiply'` fillRect at the end of the draw pipeline.

Hit pause is the highest-leverage element. Add it first inside the
juice phase and check the screenshots.

## Tasks

Each task is one commit. Use the worktree (`../bats-polish`).

### Asset pipeline

0. **Placeholder sheet generator.** Add `scripts/bake-placeholder-assets.ts`
   that calls the existing procedural `paint*` helpers (extracted /
   re-used as-is) and writes `units.png`, `terrain.png`, `fx.png` into
   `src/renderer/assets/`. Run once: `tsx scripts/bake-placeholder-assets.ts`.
   Commit the generated PNGs as the starting point.
1. **Loader.** Add `src/renderer/assets/loader.ts` exporting
   `loadAssets(): Promise<Assets>`. Use `<img>` + `decode()`. JSDOM
   fallback per §1.
2. **Wire into startup.** `main.ts` awaits `loadAssets()` before the
   first render. Add a minimal loading div in `index.html` (single
   centred "Loading…" line) and hide it on resolve.
3. **Asset-aware tests.** Update or add a shared test helper
   `tests/_lib/assetStubs.ts` that returns the stub `Assets`. Plumb it
   into any sprite/terrain/canvas test that constructs the renderer.

### Unit sprites

4. **Sheet slicer.** Rewrite `sprites.ts` internals: slice `units.png`
   into per-(type, owner, variant) caches. Palette swap on the magenta
   accent at bake time. Keep the `SpriteCache` interface unchanged.
5. **Idle frame cycling.** Add a 4-frame idle cycle, frame selected
   from `performance.now() + coordHash(unitId)`. Skip while the unit is
   mid-MOVE.
6. **Idle bob.** Continuous draw-loop offset per §2.
7. **Selection ring upgrade.** Animated dashed rotating circle in
   `canvas.ts` `drawOverlay`. Pure canvas, no anim queue.

### Terrain

8. **Autotile lookup.** Add `src/renderer/autotile.ts` exporting
   `signatureFor(map, x, y, terrain) → number` for the 4-bit signature.
9. **Sheet-based terrain renderer.** Rewrite `terrain.ts` to slice
   `terrain.png` per autotile signature + variant index. Keep
   `drawTerrain(ctx, state, vp)` as the public entry point. Capturable
   tile owner-tint comes from the dedicated sheet columns; LED dot
   logic ports as-is.
10. **Ambient water shimmer.** Two-frame glint swap on sea tiles. Per
    §2.
11. **Ambient tree sway.** ±1px horizontal offset on forest tiles, per
    §2.
12. **Factory smoke.** Particle emitter on owned factory tiles. Add a
    `FactorySmokeParticle` system in `terrain.ts` (or a new
    `terrain-fx.ts`) running continuously, owner-tinted.

### Juice

13. **Projectile anim.** New `ProjectileAnim` kind in `animations.ts` +
    draw branch in `canvas.ts`. Direct-fire variant only. Wired into
    the existing attack chain: projectile enqueued, then existing
    attack flash + reducer step.
14. **Artillery arc.** Extend `ProjectileAnim` with a `kind: 'arc'`
    flag for indirect units; parabolic path per §4. Optional whistle
    audio effect.
15. **Muzzle flash anim.** New `MuzzleFlashAnim` kind. Plays from
    `fx.png`. Spawned alongside the projectile.
16. **Impact anim.** New `ImpactAnim` kind. Small/big variants. Spawned
    when the projectile lands.
17. **Hit pause anim.** New `HitPauseAnim` sentinel kind. Damage > 30
    HP threshold (start) — tune from screenshots.
18. **Damage label anim.** New `DamageLabelAnim` kind. Pure canvas
    text. Rises + fades per §4. Test deterministically via fake
    timers.
19. **Capture flash anim.** New `CaptureFlashAnim` kind, triggered on
    CAPTURE actions that flip ownership. Terrain renderer reads a
    "flash override" so the ownership tint cross-fades cleanly.
20. **Vignette + colour grade.** Final overlay step in the draw
    pipeline. Per-map tint constants in `src/renderer/maps.ts` (or a
    new `colour-grade.ts`).

### Verification

21. **Polish-showcase shoot scenes.** Add the scenes listed in **UI
    verification** below. Drive them from `scripts/shoot.ts` by
    accepting a `--scene=NAME` flag that sets up a specific seeded
    state.
22. **Performance check.** Add `scripts/frame-budget.ts` — runs a
    headless render loop for ~10s on the busiest map (`armada`), logs
    p50/p95/p99 frame times. Goal: p95 ≤ 16 ms on the development
    machine; flag a regression if any task pushes it over.
23. **Bundle check.** `npm run build` then `du -sh dist/*` — record
    before and after; assert gzipped < 250 KB.
24. **Engine-purity check.** `mv src/renderer /tmp/renderer.bak && npx
    tsc --noEmit && mv /tmp/renderer.bak src/renderer`. Must succeed
    (a CI-friendly form lives in PLAN.md's "Hard rule").

## UI verification

Use these scenes after each work-stream finishes. Compare against the
baselines captured in Setup.

```sh
# Asset pipeline lands
npm run shoot -- --map=duel --turn=0 --out=/tmp/p1-duel-start.png

# Unit sprites land
npm run shoot -- --map=duel --p0=balanced --p1=balanced --turn=14 --out=/tmp/p2-duel-mid.png
npm run shoot -- --map=crossroads --p0=balanced --p1=balanced --turn=20 --out=/tmp/p2-crossroads-late.png

# Terrain lands
npm run shoot -- --map=armada --turn=0 --out=/tmp/p3-armada-coast.png
npm run shoot -- --map=island_hop --turn=0 --out=/tmp/p3-islands.png
npm run shoot -- --map=highlands --p0=balanced --p1=balanced --turn=12 --out=/tmp/p3-highlands.png

# Juice lands (use scene flag once task 21 is done)
npm run shoot -- --scene=projectile-arc  --out=/tmp/p4-arty.png
npm run shoot -- --scene=tank-duel-impact --out=/tmp/p4-impact.png
npm run shoot -- --scene=capture-flash    --out=/tmp/p4-capture.png
npm run shoot -- --scene=damage-numbers   --out=/tmp/p4-damage.png
```

Drop the baseline/after pairs into a diff viewer (`compare` from
ImageMagick, or just an HTML strip) when reviewing.

## Acceptance

- Side-by-side baseline-vs-after screenshots at the scenes above show a
  clear visual upgrade across units, terrain, and feedback.
- `npm test` passes. No tests deleted to make them pass. JSDOM stub for
  assets is in place and documented.
- `npm run build` succeeds. Gzipped bundle (sum of `dist/assets/*.js.gz`
  via `gzip -kc dist/assets/*.js | wc -c`) stays under 250 KB. PNG
  payload is reported separately; aim for combined PNG < 100 KB.
- `npm run lint` clean. `tsc --noEmit` clean.
- Engine-purity check: `rm -rf src/renderer && npx tsc --noEmit` still
  succeeds, restored after the check.
- Frame budget: p95 frame time ≤ 16 ms on the `armada` map at desktop
  tile size in a headless render. p99 ≤ 24 ms.
- No new dependency added to `package.json` (no Phaser, no Pixi, no
  TexturePacker — Vite handles PNGs natively).

## Out of scope

- Music. Audio polish is one-off effect additions only (artillery
  whistle, capture chime if it improves the moment); no soundtrack.
- HUD/chrome redesign (`chrome.ts` — DOM panels around the canvas).
  That's a separate plan.
- Network play, multiplayer lobby, account UI.
- New unit types, new maps, new mechanics.
- Mobile touch redesign — responsive layout still applies, but no
  bespoke touch UI.
- WebGL or shader effects. Canvas 2D only. Filter properties
  (`ctx.filter`) are acceptable where supported; feature-detect and
  no-op in JSDOM.
- Procedural art improvements to the *existing* renderer. The
  procedural code stays only as the placeholder-asset baker (task 0);
  it gets deleted once real art lands.
- AI-generated pixel art. The plan assumes real art comes from a human
  artist or a permissively-licensed pack. If we change our minds, the
  asset pipeline accepts any PNG that conforms to the sheet layouts in
  §1.

## Files you will likely touch

New:
- `src/renderer/assets/units.png`
- `src/renderer/assets/terrain.png`
- `src/renderer/assets/fx.png`
- `src/renderer/assets/loader.ts`
- `src/renderer/autotile.ts`
- `src/renderer/terrain-fx.ts` (factory smoke; optional, may merge into `terrain.ts`)
- `src/renderer/colour-grade.ts` (optional, may merge into `canvas.ts`)
- `scripts/bake-placeholder-assets.ts`
- `scripts/frame-budget.ts`
- `tests/_lib/assetStubs.ts`

Rewritten:
- `src/renderer/sprites.ts` (slice from sheet; preserve `SpriteCache` API)
- `src/renderer/terrain.ts` (autotile lookup; preserve `drawTerrain` entry)

Edited:
- `src/renderer/animations.ts` (new anim kinds: projectile, muzzleFlash, impact, hitPause, damageLabel, captureFlash)
- `src/renderer/canvas.ts` (idle bob, selection ring upgrade, projectile/flash/impact draw branches, damage label draw, vignette overlay)
- `src/renderer/easing.ts` (any new curves needed)
- `src/main.ts` (await `loadAssets()` before first render; loading-div toggle)
- `src/renderer/audio.ts` (maybe 1–2 new effects)
- `scripts/shoot.ts` (`--scene` flag + scene presets)
- `index.html` (loading div)
- Existing tests under `tests/` that construct a renderer — update to pass the asset stub
