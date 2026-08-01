# Smoke Test & UI Review — 2026-07-16

Findings from a hands-on browser smoke test (scripted real-mouse clicks via
puppeteer against `npm run dev`, 60+ screenshots) plus a read of the renderer
code. Screenshots referenced below live in `docs/smoke-2026-07-16/`.

**Caveat on screenshots:** the test container has no access to
fonts.googleapis.com, so every screenshot renders fallback system fonts, not
Fraunces / IBM Plex Mono. Typography judgements below account for that; the
structural findings don't depend on it.

What was exercised: full hot-seat loop on duel (select → move-preview →
commit → action menu → capture ×2 → build → attack with damage preview →
counterattack → cancels via Esc/right-click/off-board click → End Turn via
button and Enter), unaffordable-build no-op, fog on/off + per-player masking,
armada (naval) map, coastal vs inland build menus, mobile viewport (390×844),
editor mode, save/load/replay toolshelf, mid-game controller switch to AI,
and a full balanced-vs-aggressor match to the win modal. Console captured
throughout; no uncaught exceptions anywhere.

Baseline: `npm test` = 409/410. The one failure is the perf assertion in
`ai-tier3-vs-tier1.test.ts` (crossroads max turn 213.7ms vs the 200ms
budget) — likely just a slow container, but it's the second-slowest-hardware
signal this budget has produced; worth keeping an eye on.

---

## Bugs (ranked)

**Status as of 2026-08-01: all six bugs below are addressed** — each carries an
**Addressed** marker pointing at the fix and its test. The write-ups are kept as
originally reported (present tense, pre-fix) for the diagnosis and repros. The
"Small stuff" list below is likewise closed out. The only thing still open
anywhere in this file is two of the #7 nits in the UI review — the capture
badge and the built-this-turn state.

### 1. Pressing Enter during the AI's turn silently skips the human's next turn

**Addressed:** both halves of the suggested fix shipped. The Enter keybind is
gated on an `endTurnAllowed()` predicate, which `main.ts` wires to
`!aiDriver.inputLocked(state) && !animQueue.busy() && !handoffActive()`; and
`ai-driver.ts` drops `pendingPlan` (and clears `planOwner`) as soon as
`currentPlayer !== planOwner`, so the trailing `END_TURN` can't leak into the
human's turn. See `endTurnAllowed` + the `keydown` handler in
`src/renderer/input.ts`, and `tests/end-turn-guard.test.ts` (both the stale-plan
case and "does NOT dispatch END_TURN on Enter when endTurnAllowed() is false").

Repro (scripted, deterministic): `?p1=balanced`, end your turn, then press
Enter ~0.7s into the AI's turn. Observed: turn indicator goes
`Turn 02 COBALT` → settles at `Turn 05 VERMILION`. The human's turn 03 was
never playable; the AI also lost the rest of its own turn 02 plan.

Cause, two halves:

- `input.ts` binds `keydown Enter → dispatch END_TURN` with **no
  `aiDriver.inputLocked()` or `animQueue.busy()` check**. The canvas
  click-blocker in `main.ts` only intercepts *canvas* clicks. The DOM
  **End Turn button in `chrome.ts` has the same hole** (it only checks
  `winner`).
- `ai-driver.ts` plans a whole turn upfront (`pendingPlan` ends with
  `END_TURN`) and `dispatchNext()` keeps draining the plan even after
  `currentPlayer` changed. The stale unit actions get rejected by the
  validators, but the trailing `END_TURN` is always legal — it fires during
  the *human's* turn and ends it.

Since the button literally advertises `↵`, impatient players will hit this.
Suggested fix: guard both entry points on
`aiDriver.inputLocked(state) || animQueue.busy()`, **and** make the driver
abandon `pendingPlan` whenever `state.currentPlayer !== planOwner` (defence
in depth — external END_TURNs can come from anywhere).

### 2. Map editor (`?editor=1`) is unusable

**Addressed:** the full-viewport canvas rules in `index.html` are now scoped to
`canvas.board` (the game board sets `className = 'board'` in `src/main.ts`), so
the editor's canvas keeps its intrinsic size and its click→tile math. See the
comment above the `canvas.board` block in `index.html` and `tests/editor.test.ts`.

`docs/smoke-2026-07-16/editor.png` — the page is a bare stretched grid; the
editor's own toolbar, brush palette, and status line are invisible, and
painting clicks land on the wrong tiles.

Cause: the global rule in `index.html`
(`canvas { position: absolute; inset: 0; width: 100vw; height: 100vh }`)
also hits the editor's canvas: it gets stretched over the entire viewport,
covering the editor's DOM chrome, and since the canvas backing store stays at
`16×36 = 576px` wide, `offsetX / EDITOR_TILE_SIZE` maps clicks at ~2.2× the
intended coordinates. Fix: scope those CSS rules to the game canvas (class
it, e.g. `canvas.board`) or have the editor set explicit
`position: static; width/height` inline (it already sets `cssText`, so add
the overrides there).

### 3. Coastal build menu overflows the viewport and the bottom chrome

**Addressed:** the menus moved to DOM popovers (UI review #5) and the build list
takes the robust max-height fix — `max-height: min(60vh, 460px); overflow-y: auto`
on `.menu-build .menu-build-list`, plus a bottom-sheet variant under
`pointer: coarse`. See `src/renderer/menus.ts:~267` and `tests/menus.test.ts`
("renders all 14 build entries in one list", "coarse pointer flips the build
menu to a bottom sheet, still 14 entries").

`docs/smoke-2026-07-16/armada-build-menu.png` — on armada, the coastal
factory menu has 14 entries (≈512px). It gets clamped to the bottom edge,
where the last rows (Submarine, Carrier) are half-clipped and sit *under*
the DOM toolshelf — the MAP dropdown swallows their clicks (DOM chrome is
above the canvas; `hud.hit` never gets a chance). On a shorter window even
more of the menu is unreachable. `buildMenuLayout` clamps top at
`BOARD_TOP_INSET + 4` but has no max-height handling. Fix: cap the menu
height and paginate/scroll, use two columns, or reserve
`BOARD_BOTTOM_INSET` in the clamp the way the top is reserved (that still
breaks on small windows — a real max-height is the robust fix).

### 4. Mobile layout is unplayable (chrome, not board)

**Addressed:** the DOM chrome gained the responsive breakpoint it lacked —
`@media (max-width: 720px)` in `src/renderer/chrome.ts:1484` keeps Coffer
visible (grid children get `min-width: 0`), wraps and collapses the toolshelf
behind a disclosure, and guarantees a full-size End Turn button. Beyond that, a
dedicated mobile-first shell shipped (`?mobile=1|0`: HUD strip over a
camera-driven full-bleed board over a command tray) — see plans/README.md's
**Shipped** section and `e2e/{mobile,mobile-grammar,camera}.e2e.ts`.

`docs/smoke-2026-07-16/mobile.png` (390×844) — the board itself renders and
taps select units fine, but: the player panels overflow so **funds are
invisible**, and the bottom bar overflows so the controllers strip and the
**End Turn button don't exist on screen**. With no keyboard on a phone,
there is no way to end a turn. The chrome needs a stacking/responsive
breakpoint (the canvas renderer already has one via `TILE_SIZE_MOBILE`, the
DOM chrome has none).

### 5. Remote font dependency + favicon 404

**Addressed:** both families are self-hosted — `public/fonts/` carries the
Fraunces and IBM Plex Mono `.woff2` files and `public/fonts/fonts.css`, which
`index.html` links instead of fonts.googleapis.com. The favicon 404 is gone too:
`public/favicon.svg`, linked from `index.html`. (The caveat at the top of this
file — that these screenshots show fallback fonts — still describes the
screenshots, not the current build.)

The page hard-depends on fonts.googleapis.com (Fraunces, IBM Plex Mono);
offline/blocked networks silently get system fallbacks (all screenshots
here demonstrate the fallback look). Self-hosting the two families (they're
OFL) removes the flake and the FOUT. Also `favicon.ico` 404s on every load.

### 6. "Turn NN" counts plies, not rounds

**Addressed (QoL chunk):** chrome now displays `Day ⌈turn/2⌉` in the turn
indicator (`Turn NN` → `Day NN`) and the win-modal subtitle ("on day 15." for
a 30-ply match). The engine still increments `turn` per ply, and the
replay/debug surfaces stay raw. See `src/renderer/chrome.ts` (`dayOf`) and
`tests/chrome.test.ts`.

The engine increments `turn` on every END_TURN, and the chrome displays it
raw: after each player has moved once the header says "Turn 03"; the win
modal says "captured the field on turn 30" for a 15-round match. Either
display `Day ⌈turn/2⌉` (AW convention) or track rounds in the engine.

### Small stuff

- ~~`checkWinner`'s both-players-at-zero case is still tracked as a known
  `test.fails`.~~ **Corrected:** this reconciliation was based on a stale
  reading — there is no `test.fails` marker for it anywhere in the suite.
  BUGS.md Bug 1 is genuinely fixed (`src/engine/systems/win.ts:33`) and pinned
  by passing tests in `tests/win-acceptance.test.ts`. Nothing to reconcile.
- Switching map / toggling fog mid-game reloads the page and silently
  discards the current match. Cheap guard: `confirm()` when `turn > 1`.
  **Addressed (QoL chunk):** both the map picker and the fog toggle now
  `confirm('Abandon the current match?')` when `turn > 1 && winner === null`;
  cancelling the map picker restores the select to the loaded map. See
  `createMapPicker` / `createFogToggle` in `src/renderer/chrome.ts`.
- ~~`createInputController` builds its own `createHud(renderer)` while
  `main.ts` builds another for drawing — a trap if the hud ever grows state.~~
  **Addressed:** the duplicate-instance trap is gone. `src/renderer/hud.ts` no
  longer exports `createHud` at all (it is now pure helpers — `UNIT_LETTER`,
  `buildMenuEntries`, `unitLabel`), and canvas menu hit-testing was replaced by
  the DOM menus in `src/renderer/menus.ts`. The only `createHud*` left in the
  tree is the unrelated mobile `createHudStrip`
  (`src/renderer/mobile/hud-strip.ts`), built once in `main.ts`.

---

## UI review

**Addressed since this review** (only items that actually shipped):

- #2 board doesn't use the screen → **Phase 2A** (fit-to-viewport tile scaling).
- #3 ownership legibility → **Phase 3A** (team-ramp unit bodies) + **3B** (team
  roof/banner/pad baked into city/hq/factory tiles).
- #4 HP has no numbers → **Phase 3B** (AW-style baked HP numeral + capture meter).
- #5 menus feel like a different product → **Phase 2B** (DOM menus, chrome font)
  + **3B** (build entries show baked unit sprite icons).
- #6 hot-seat fog has no handoff → **QoL chunk** (opaque pass-the-device scrim
  between two human players under fog; blocks canvas + Enter until "Begin
  turn"). See `src/renderer/handoff.ts`, `tests/handoff.test.ts`,
  `e2e/fog-handoff.e2e.ts`.
- #7 "1 UNITS" plural nit → **QoL chunk** (units stat label is now
  singular/plural: "1 UNIT" / "0/2 UNITS"; "COFFER" left as identity). See
  `createPlayerPanel` in `src/renderer/chrome.ts`, `tests/chrome.test.ts`.
- #1 range overlays turn to mud → **range-overlay redesign** (attack overlay is
  now the reachable-subtracted fringe, so red = "can hit but can't stand" and
  never stacks over blue; each overlay group gets a crisp 1px union-boundary
  border so a range reads as a shape; the capturable wash is gated to canCapture
  selections and no longer washes in idle). See `getOverlay`/`attackFringe` in
  `src/renderer/input.ts`, `drawOverlays`/`strokeGroupBorder` in
  `src/renderer/canvas.ts`, `tests/overlay.test.ts`.

**Still open — the ONLY open items in this document:** two of the #7 nits.
Everything else in this file (bugs 1-6, UI review 1-6, the #7 plural label, and
the #7 cancel hint) has shipped. Specifically still to do:

- capture-progress badge is a ~10px chip that's easy to miss — an AW-style
  shrinking building meter or a progress pie on the flag would read better;
- built-this-turn units get no "can't act" visual distinct from spent units.

(The third nit, "Esc/right-click cancel is undiscoverable", is **Addressed** —
`createCancelChip` in `src/renderer/chrome.ts` floats a bottom-centre
`Cancel esc` chip for every non-idle input state, ≥44px tap target, with the
`esc` key hint hidden under `pointer: coarse`. Asserted in `e2e/mobile.e2e.ts`.)

The chrome (player panels, turn indicator, toolshelf, win modal) has a
coherent, confident identity — warm dark panels, mono labels, the
Vermilion/Cobalt naming is charming. The board art (PixelLab terrain,
ambient tree sway, water shimmer) is genuinely pleasant. The gap is in the
**information layer** — overlays, menus, badges — which is where a tactics
game lives. Specific critiques, roughly by impact:

1. **Range overlays turn to mud.** On selecting a direct-combat unit,
   `computeAttackArea` returns every reachable tile plus the fringe, and
   `drawOverlays` stacks red (α .34) over blue (α .30) on all of them —
   the "where can I go" signal becomes an ambiguous mauve, while the
   attack-only fringe reads orange (`docs/smoke-2026-07-16/overlay-selected.png`).
   Then in move-preview state the attack overlay vanishes and the same
   range is suddenly clean blue (`overlay-move-preview.png`) — two states,
   two palettes, one concept. Recommend: blue fill = reachable, red only on
   tiles attackable-but-not-reachable (or a red *outline* ring), identical
   in both states. The faint yellow "capturable" wash on top adds a third
   simultaneous tint; consider showing it only for infantry selections.
2. **The board doesn't use the screen.** Tile size is fixed at 48px, so on
   a 1280×900 window the duel map occupies under 20% of the viewport,
   floating in a large cream void (and the pale radial glow behind the
   board fights the otherwise dark chrome — in fog mode the dark board on
   a bright halo looks inside-out). Scale tiles to fit
   (`min(usableW/cols, usableH/rows)` clamped to, say, 40–96px) and
   consider a dark surround behind the board.
3. **Ownership legibility.** Team identity on units is carried by small
   clothing/trim pixels; at 48px, red vs blue units on busy tiles (or
   standing on owned structures) take real squinting on a full board
   (`midgame.png`). Structure ownership is a ~6px flag. A stronger team
   tint, colored outline, or team-colored HP chip would fix both at once.
4. **HP has no numbers.** Bars appear only once damaged, always green, and
   4-6px tall — you can't compare two damaged units at a glance, and the
   damage preview ("Dealt 49 HP") speaks in numbers the board never shows.
   The AW corner digit (1–10) exists in the design docs already
   (QUESTIONS.md flagged the rounding); surfacing it would make combat
   math tangible.
5. **Canvas menus feel like a different product.** Action/build menus use
   `-apple-system` at 13px with no hover/focus affordance, next to chrome
   set in mono caps. Since DOM already floats above the canvas everywhere
   else, these could be DOM popovers (hover states, scrolling for bug #3,
   and font consistency all come free). At minimum, adopt the chrome font
   and add a hover highlight via `hud.hit` on mousemove.
6. **Hot-seat fog has no handoff moment.** *(→ Addressed, QoL chunk — opaque
   pass-the-device scrim, see above.)* The instant you press End Turn,
   the other player's vision is revealed — with both players at one screen
   the previous player sees it. An interstitial ("pass to Cobalt — click
   when ready") is the genre solution and would also give fog matches a
   rhythm.
7. **Nits:** "COFFER"/"UNITS" labels read as "$0 COFFER" and "1 UNITS"
   (singular/plural *(→ UNIT/UNITS Addressed, QoL chunk)*; maybe "Funds"); capture-progress badge is a ~10px
   chip that's easy to miss (an AW-style shrinking building meter or a
   progress pie on the flag would read better); Esc/right-click cancel is
   undiscoverable (a one-line hint in the empty bottom-center would do)
   *(→ Addressed — bottom-centre cancel chip, `createCancelChip` in
   `src/renderer/chrome.ts`)*; built-this-turn units get no "can't act" visual
   distinct from spent units.

## What's solid (keep)

- Engine correctness end-to-end: previewed damage matched applied damage
  exactly (49/25 in my run); counterattacks, income, capture reset, and
  units-to-act counter all behaved.
- Unaffordable build entries correctly refuse clicks; sea units correctly
  filtered from inland factory menus.
- Cancel ergonomics (Esc, right-click, click-off) all work from every
  state I could reach.
- Mid-game controller handoff to AI works cleanly, win modal + input lock
  after victory works, replay modal opens/closes cleanly.
- AI-vs-AI (balanced vs aggressor) ran 30 plies to a decisive HQ capture
  with zero console errors and smooth animation pacing.
