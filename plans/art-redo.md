# Art redo — pixel-art style guide

Reference for the in-repo, hand-authored pixel art: the unit sprites (Phase 3A)
and the terrain tiles + digit atlas (Phase 3B). Read this before touching
anything under `src/renderer/assets/pixel-art/`. The unit contract is below; the
terrain + digit conventions are in the **Phase 3B** section near the end.

## Context

Phase 3A replaced the 28 external PixelLab unit PNGs with 14 hand-authored
16×16 char-grids, baked at startup into per-team, per-variant sprites. The bar
was a **bold Advance-Wars look**: chunky 3/4-ish forms, a thick 1px dark
outline, saturated team-colour bodies, and silhouette-first readability so every
unit is tellable apart at tile size. Terrain stays PNG until Phase 3B.

The art is data (`string[]`), so it's diffable in review and testable without a
canvas. The bake (`src/renderer/sprites.ts`) turns each grid into a 16×16 canvas
that `canvas.ts` blits scaled to the tile (imageSmoothing stays off → crisp).

## Background reading

In dependency order:

- `src/renderer/assets/pixel-art/types.ts` — the `PixelGrid` type (16×16).
- `src/renderer/assets/pixel-art/palette.ts` — `FIXED_PALETTE` + the A/B/C/D
  team-ramp contract + `'.'` transparent.
- `src/renderer/canvas-palette.ts` — `PLAYER_COLOURS[owner].ramp` (the 4 team
  colours resolved into A/B/C/D at bake).
- `src/renderer/assets/pixel-art/units/*.ts` — the 14 grids + `index.ts`
  aggregator (`UNIT_GRIDS`).
- `src/renderer/assets/pixel-art/soot.ts` — the shared damage decal.
- `src/renderer/assets/pixel-art/validate.ts` — the pure validators.
- `src/renderer/sprites.ts` — the char→RGBA rasteriser / bake pipeline.

## The char-grid format

A sprite is `string[]`: **16 rows of exactly 16 chars**. Row 0 is the top, col 0
is the left. Each char resolves to a colour at bake time:

| Char        | Meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `.`         | transparent (shows the terrain behind — sprites sit in a tile) |
| `A B C D`   | **team ramp**, dark→light: shadow / base / light / highlight   |
| everything else | a `FIXED_PALETTE` colour (shared, player-independent)      |

The fixed palette (~16 warm-tuned colours) is: `K` outline (warm near-black),
`E F G H I` steel/gunmetal dark→highlight, `J L` glass/canopy (teal shadow +
lit), `M N P` track/wood/tyre browns, `Q` warm white, `R` rotor grey, `S`
soot/exhaust, `W` gold accent. See `palette.ts` for the exact hexes and why they
lean warm (to sit with bg `#14110d` / gold `#d4a857`).

### Team ramp contract

`A/B/C/D` are resolved per player from `PLAYER_COLOURS[owner].ramp`:

- p0 crimson: `#6e1616 / #c83030 / #e05a4a / #f2937f`
- p1 cobalt:  `#14306e / #2860c0 / #4a86e0 / #8fb4f2`

Chosen around the existing base hues so nothing else in the UI shifts; shadows
are deep + desaturated to seat the form, highlights push one clear step brighter
without going pastel. **Author once, facing right (p0); owner 1 is the same grid
mirrored horizontally at bake.** So: no text, no asymmetric insignia — anything
that would read wrong flipped.

## Style rules

- **Outline.** Wrap the full silhouette in a 1px `K` outline.
- **One light source, top-left.** Put `C`/`D` (and steel `H`/`I`) on upper-left
  surfaces, `A` on lower-right ones.
- **Team-coloured body.** ≥25% of a sprite's opaque pixels must come from the
  team ramp (A–D) — the body/hull *is* the army colour; steel/glass/tracks are
  accents. (`teamPixelRatio` enforces this.)
- **Silhouette first.** Each type must be distinguishable from every other at
  ~24px. Lean on big shapes, not detail:
  - tank = low hull + big turret + one flat barrel right
  - artillery = one long diagonal barrel up-right on a carriage
  - aatank = twin barrels pointing up
  - recon = tall wheeled body, antenna, exposed wheels (no turret)
  - infantry = ~10px soldier, helmet + rifle
  - copter = fat body under a horizontal rotor bar + tail rotor
  - transport = boxier body + upright tail rotor
  - fighter = swept delta (pure arrowhead)
  - bomber = wide straight wing bar + twin engine pods
  - battleship = long hull + turret spine (multiple structures)
  - cruiser = hull + single tower + one missile box
  - submarine = low rounded hull + one conning fin
  - lander = flat boxy barge, near-featureless top
  - carrier = long flat deck + offset island
- **Margins.** Keep the outer 1px mostly empty (sprites sit inside tiles). Naval
  hulls are the exception — they may span the full 16px width.

## Damage variant

`damaged` (drawn when `hp < 50`) is baked from the same grid by:

1. dimming the team ramp + steel stops ~35% (`DAMAGE_DIM` in `sprites.ts`);
2. stamping the shared `SOOT_DECAL` — scorch (`S`) + a couple of gold embers
   (`W`) biased to the lower-right — **only where the unit is opaque**.

Outline, tracks, glass, gold and foam keep their value, so a beaten unit reads as
"same shape, darker + scorched", not repainted.

## How to iterate

1. Edit a grid under `units/` (or the palette / ramp / soot).
2. `npm run sprites -- --out=/tmp/sheet.png` renders the contact sheet: every
   type × {p0,p1} × {clean,damaged} at 3× and 6×, plus a 24px silhouette strip
   over grass + sea. Read the PNG, judge silhouette/team-read/mud, repeat.
3. `npx vitest run tests/pixel-art.test.ts` re-checks the objective bars.

The contact sheet lives behind `?sheet=1` (see `pixel-art/sheet.ts`, wired in
`main.ts`); `scripts/sprite-sheet.ts` screenshots it headlessly.

## Validator thresholds (`tests/pixel-art.test.ts`)

- **dimension / chars** — 16×16, every char in `FIXED_PALETTE ∪ {A,B,C,D,.}`.
- **team ratio** — `teamPixelRatio ≥ 0.25` for every unit (current roster:
  28–63%).
- **distinct chars** — ≥3 distinct non-transparent chars per grid (no flat
  blobs; current roster: 4–9).
- **pairwise silhouette distance** — `silhouetteDistance ≥ 18` for every pair.
  Distance is the XOR of two opacity masks. The plan floor was 12; the roster's
  worst pair (battleship/carrier) is 23, so the enforced bar is **18** — real,
  with headroom for future tweaks.

## Acceptance

- `tsc`, `lint`, unit tests, e2e all green.
- Every unit reads as its type and its team on the contact sheet at 24px.
- Damaged is visibly a dimmed + scorched version of clean.

## Phase 3B — terrain, digits, menu icons (shipped)

Phase 3B finished the sprite redo: terrain is now hand-authored pixel art too,
the on-board numerals are baked pixel glyphs, and the build menu shows the real
unit icons. All external PNGs are gone — `assets/loader.ts`, `assets/raw/` (28
dead unit PNGs) and `assets/terrain-raw/` (8 PNGs) were deleted and `main.ts`
boots synchronously (no `loadAssets` await).

### Terrain grids (`assets/pixel-art/terrain/`)

Same char-grid form as the units (16×16 `string[]`), but three rules differ —
see `terrain/palette.ts`:

- **Full-bleed.** Every cell is opaque; there is **no `.` transparent cell**
  (the validator rejects one). Tiles butt edge-to-edge, so the bake needs no
  gutter crop and `drawTerrain` blits the 16×16 source straight to the cell.
- **Own palette.** `TERRAIN_PALETTE` is terrain-only (greens / blues / warm
  earth / concrete), tuned to sit with the existing board hue so the per-map
  colour-grade keeps reading the same. The team-ramp cells (`A/B/C/D`) are
  shared verbatim with the units.
- **Owner variants.** The capturables (`city` / `hq` / `factory`) carry a few
  team-ramp cells on the roof / banner / pad and bake **three ways** — neutral
  (`NEUTRAL_RAMP`, steel greys) + p0 + p1 — keyed by owner in the cache. Every
  other terrain has **no** team cells and bakes once. HQ is the grandest (mast +
  banner), factory industrial (chimney + roll door), city civic (window towers).
- **Seam-safety.** Because every cell of a type bakes to the *same* tile, any
  bold or dense feature repeats into a visible grid (worst on open water). Keep
  the outer 1px ring a single uniform base char, and keep interior texture
  sparse + low-contrast. `tests/terrain-art.test.ts` enforces the uniform border
  and the full-opacity / palette-closure / owner-difference bars.

Because ownership is baked into the tile, the baked path drops the LED/stripe
owner cue entirely; the procedural fallback (jsdom, no canvas) still draws it.

### Digit atlas (`assets/pixel-art/digits.ts`)

`DIGIT_GLYPHS` are 3×5 `#`/`.` glyphs for 0–9. `canvas.ts` bakes each once into a
tiny outlined canvas (1px dark dilation behind white ink) and blits it scaled
with imageSmoothing off — sharp at ~10px, unlike `fillText`. Used for the
AW-style HP numeral (`ceil(hp/10)` → 1–9, bottom-right, alongside the bar) and
the capture flag-meter (pixel flag + progress number, top-left).

### Menu build-icons

`menus.ts` renders each build entry's chip as an `<img>` from
`spriteCache.toDataURL(type, currentPlayer)` (nearest-neighbour via
`image-rendering: pixelated`), falling back to the `UNIT_LETTER` chip when the
cache is in stub mode (no data URL). The icon tracks `state.currentPlayer`.

## Files Phase 3A touched

- `src/renderer/assets/pixel-art/**` (new: palette, types, validate, soot,
  units/*, sheet)
- `src/renderer/sprites.ts` (rewrote as the bake pipeline)
- `src/renderer/canvas-palette.ts` (added 4-stop `ramp`)
- `src/renderer/assets/loader.ts` (dropped the unit glob, kept terrain)
- `src/main.ts` (sprite-cache wiring + `?sheet=1`)
- `scripts/sprite-sheet.ts` + `package.json` (`npm run sprites`)
- `tests/pixel-art.test.ts` (new), `tests/sprites.test.ts` (rewritten)
