# Open Questions

Questions and assumptions logged during autonomous execution. Resolved questions stay here with their resolution for future reference.

## Resolved (initial)

- **Phase 6 scope** — User confirmed full Phase 6 (animations, save/load, replay, sound stub, sprites stub, more maps, map editor).
- **AI iteration depth** — 3–4 distinct personas, ~50 matches each.
- **Git** — Initialized, commit per phase.

## Assumptions (not blockers, listed for visibility)

- Using `npm` (not pnpm/yarn/bun).
- Sprites: placeholder generated assets only; no licensed art.
- Sound: a tiny stub (one tone) — full audio out of scope unless asked.
- Crossroads map (Phase 2 mentions duel.json explicitly, crossroads.json implied by Phase 5 acceptance) — will design a sensible 16×10 map with two factories per side and a central contested area.
- "AI-vs-AI CLI mode" runs via Node, not in a browser. Headless engine + AI imports.
- Logging: structured via a tiny logger that writes to console and an optional in-memory ring buffer; AI-vs-AI matches dump JSONL action logs to `logs/`.
- Determinism: a seeded RNG (mulberry32) threaded through the AI.

## Open

- **Stalemate / no-progress draw** (Phase 1 builder): PLAN.md defines win only via HQ capture or rout. If both sides camp and refuse to capture, the game runs forever. Should we add a turn cap or "no kills/captures in N rounds" draw rule? Punted to Phase 6.
- **Built-unit funds order** (Phase 1 builder): BUILD action's `owner` field is technically redundant with `state.currentPlayer` (only the current player can build). Kept for now to match the type in PLAN.md exactly; could simplify in Phase 2.
- **HP display rounding** (Phase 1 builder): HP is stored 0–100 but PLAN.md says "displayed as 1–10". Round-down? Round-up? `ceil(hp/10)` with a special-case for 0 is the natural answer — leaving for renderer (Phase 3) to decide.
- **Capture-progress on END_TURN for non-current player** (Phase 1 builder): currently progress only resets when (a) the unit moves off, or (b) the player whose turn just began has a unit on a non-enemy capturable tile. This matches the spec but means an enemy infantry parked on a city you re-take keeps its progress through your turn — fine, since their next CAPTURE legality check fails (tile.owner === u.owner). Flagged because the interaction is subtle.

## Phase 2 (builder)

- **Stub-AI scope.** Built a deliberately minimal stub in `src/cli/run-match.ts` (move-or-attack-or-wait, biased toward the enemy HQ). The plan is explicit that Phase 4 owns the real Tier 1 AI in `src/engine/ai/*`. I made sure none of the stub leaks into the engine — it lives only under `src/cli`. The duel map terminates by rout in ~40 turns with seed=42; crossroads takes ~140 turns with seed=7. Both are well under any sensible cap.
- **Map name field.** `duel.json`/`crossroads.json` carry a `name` field, but `GameState` has nowhere to store it (PLAN.md's GameState shape has no map metadata). The CLI tracks it locally. If Phase 3 wants to display the map name in the HUD we'll need to thread it through `GameState`, or expose a parallel `loadMapMetadata` helper. Easy follow-up.
- **JSON imports + verbatimModuleSyntax.** With `resolveJsonModule: true` and `verbatimModuleSyntax: true`, plain `import x from './x.json'` works in both Vite and tsx/Node. I avoided the new `with { type: 'json' }` import-attributes syntax because Node 22 + tsx supports it but it's not yet ergonomic across the toolchain.
- **Infinity in JSON.** Used `null` for impassable move costs (Infinity isn't representable in JSON). The loader converts. Documented at the top of `loader.ts` and `terrain.json`.
- **Stub may keep WAITing.** The stub picks the first unit it can find that hasn't acted; if that unit can't move or attack profitably, it WAITs. Real matches still terminate because (a) it tries every unit before END_TURN, (b) one side eventually pushes infantry forward and starts capturing, (c) we have a maxTurns hard cap. Phase 4's utility AI will obviously do this far better.
- **Test for two-units-same-tile in maps.** Added to the loader. Strictly speaking PLAN.md doesn't say anything about this — but allowing it would break combat resolution since `unitAt` short-circuits on the first match. Fail-fast at load time is the safe choice.

## Phase 3 (builder)

- **Input lock during animations.** Picked "ignore" (not "queue") for clicks while `animQueue.busy()`. Hot-seat play hardly notices — Phase 4 with AI turns and longer chains may want to revisit.
- **Action menu auto-Wait when empty.** If the unit's only option after MOVE is Wait, the menu lists Wait alone. I considered auto-committing Wait but decided the explicit click is less surprising; the menu still appears so the player can see the unit "is done".
- **HP display.** Settled on `ceil(hp/10)`-style segmented HP bar (segments 1–10) for damaged units; full-HP units show no bar to reduce visual noise. Matches PLAN.md's "1–10" display intent without needing a numeric label.
- **JSDOM `getContext('2d')` warning.** JSDOM still logs "Not implemented: HTMLCanvasElement's getContext()" via its virtual console even though tests override `canvas.getContext` with a stub. Suppressed at the `console.error` boundary in the test file. If we ever switch to `node-canvas`, this can go.
- **Damage preview parity.** `previewAttack` lives in `combat.ts` and is consumed by both the renderer (hover tooltip) and the test harness (`damage-preview.test.ts`). The reducer still goes through `resolveAttack`; both share `computeDamage` so they stay in sync. The test brute-forces every melee pair + terrain × HP variations.
- **Forest mountain pattern.** Used Canvas primitives (dots / triangle) for forest/mountain visual hints rather than texture images. Sprites land in Phase 6.
- **Esc / Enter keybinds.** Esc cancels selection (matches PLAN.md). I added Enter as a convenience to end the turn — not in the spec, easy to remove if undesired.
- **Crossroads map.** Phase 3 only asks for the duel map; main.ts loads `duel.json` directly. To switch maps in dev today, hand-edit main.ts. Phase 6's map-picker UI is the proper home for runtime selection.

## Phase 5 (builder)

- **Acceptance interpretation.** PLAN.md says "Tier 2+3 AI beats Tier 1 AI ≥7/10". A "win" can mean raw rout/HQ-capture, OR the tournament harness's adjudication (HQ-tile count tiebreak, then HP-weighted unit-cost tiebreak). On crossroads, tier3 dominates on material but rarely manages a rout-or-HQ-capture inside 200 turns — yet the tournament records tier3 winning 10/10 by adjudication. The acceptance test uses the same adjudication as the `npm run tournament` harness, since that's what the BUILDER brief lists as the success metric.
- **Tier 3 unit cap.** Without a cap, the AI's per-turn time blew past 200ms because tier3 keeps building and ends up acting 30+ units per turn (60+ actions × ~3ms each). Added `TIER3_UNIT_CAP = 12` to the build phase when `useRoles` is on; it floats with kills so the AI replenishes losses. Tier 1 unaffected.
- **Threat/value maps cached PER TURN, not per action.** Originally I invalidated all caches after every reducer step. Enemy positions don't change during our turn (we only move our units; the enemy is static), so the threat map, value map, role assignments, and frontline target are stable. The lone exception is when our attack kills an enemy — their (now-stale) threat contribution remains in the map, an over-estimate that's safe to keep. The enemy-reach cache for the Phase 4 `futureThreat` fallback is still invalidated per action.
- **Precedence for role assignment.** PLAN.md doesn't pin one. I chose `defender > capturer > support > frontline` — defending the HQ when it's under real threat is more important than offensive objectives, and damaged/artillery units retreating override frontline. Documented in `roles.ts`. The acceptance test "low-HP unit → support" works because the test places the unit far from the HQ with no enemies in range, so the defender branch is inactive.
- **Roles persist through a turn.** I deliberately do NOT re-assign roles after each action. Re-assigning would let a unit shift from defender→capturer the moment it killed a threatening enemy, defeating the point of stable archetypes within a single turn. Roles can change between turns.
- **Effective weights pre-multiplied per unit per turn.** Computed once when scoring starts for a unit. Avoids per-candidate allocation of a fresh weights object — small but real perf win at ~1k candidates/turn.
- **Frontline target = hottestThreatTile.** PLAN.md says "toward the highest threatMap concentration of OURS (i.e., where we project damage)". The frontline objective bonus computes the hottest tile in the precomputed threat map and rewards moves that close the manhattan distance to it. Cached once per turn.
- **valueMap chokepoint formula.** PLAN.md says "passability bonus: tiles you can stand on at all... average across the four ground classes". There are three ground classes (foot, wheel, tread) — sea is its own class with no overlap, and air ignores ground terrain. I averaged over the three ground classes; air units don't benefit but they don't really care about chokepoints either.
- **Stale-positive threat after enemy kill.** When our attack removes an enemy, its tile contributions still appear in the threatMap until the next turn. This makes the AI slightly more cautious for the remainder of the turn, which is OK and well within the budget margin. Not worth the cost of recomputing every action.

## Phase 4 (builder)

- **`AI` interface — function vs object.** PLAN.md sketches `type AI = (state, player) => Action[]` but the brief specified an object with `name` + `takeTurn`. Adopted the object shape — it's friendlier to the tournament logger (every match record can name the AI directly) and lets the factory carry weight overrides cleanly. The function-form contract is preserved by having `takeTurn` be a pure transformer.
- **Random AI BUILDs.** The bare random spec says "pick uniformly among legal actions per unit". Building is per-factory, not per-unit. To prevent random sitting on cash (which makes the match drag on into rout-only territory), I added a 50%-per-factory build coin-flip biased toward the most expensive affordable unit from {infantry, recon, tank}. Excluded artillery + copter from random's build menu — random can't operate them well and would tilt the matchup. Default weights still produce a clean 10-0 utility sweep.
- **Per-player RNG seeding.** Each AI receives an independent RNG derived from the match seed (`seed*2+1` for p0, `seed*2+2` for p1) so utility's deterministic decisions and random's stochastic ones don't interfere. The integration-cli determinism tests still pass under the new defaults.
- **`futureThreat` worst-case BFS.** The threat term reaches all tiles passable for the enemy's movement class ignoring unit blockers (worst case). This is intentionally pessimistic — accurate-but-pricey enemy-movement modelling lives in Phase 5's threat map.
- **Self-death penalty (-50).** Added to discourage suicide moves: if the chosen action causes our acting unit to die in a counter, the score takes a flat -50 penalty plus the usual counter-risk term. Not in PLAN.md verbatim; flagged here.
- **No weight tuning required.** Default `ai-weights.json` (damageDealt 1.0, capture 1.5, counterRisk 0.8, futureThreat 0.5, positional 0.3, objective 0.6) already produces 10-0 vs random in both p0 and p1 positions, with avg AI turn ~8ms. Did not modify the weights file.
- **Tournament adjudication.** Hit-the-turn-cap matches break ties via (a) HQ tile ownership count, (b) total unit cost on board (HP-weighted), (c) declared draw. In the 10 acceptance matches, none hit the cap (all rout wins by turn ~30-60), so adjudication is currently exercised only through synthetic tests.
- **Renderer AI panel is DOM, not Canvas.** The canvas is full-screen and adding canvas-drawn dropdowns is overengineering. Floating top-right DOM panel with two `<select>`s matches the PLAN.md "AI controls panel in the HUD" intent without entangling the canvas hit-testing.
- **`ai-trace` log category.** Added as a new, default-disabled category for per-candidate score traces. Enable via `setLogEnabled('ai-trace', true)` or `?ai-trace=1` URL param. Off in tests and production runs.

## Phase 6 (builder)

- **Network play deferred.** Per the brief, dropped from Phase 6 scope. Everything else (animation polish, save/load, replay, sound, sprites, more maps, map editor) is implemented and covered by tests. No design work was begun on netplay — keep it out of v1.
- **Save schema version envelope.** `serialize`/`deserialize` wrap GameState in `{ kind: 'bats-save', version: 1, savedAt, state }`. Mismatched versions raise a clear error. Bump `SAVE_SCHEMA_VERSION` whenever GameState's shape changes.
- **Replay log header line.** `runMatch` now writes a JSONL header line `{ type:'header', map, seed, p0, p1, startedAt }` before any actions, followed by `{type:'action'}` lines and a closing `{type:'summary'}`. The replay CLI parses these via `parseLog`. Older logs without a header line need `--map` to be passed explicitly.
- **Audio defaults muted.** Per the brief, default state is muted to avoid surprising the user. `?sound=1` URL param flips the initial state to unmuted. The first canvas click calls `audio.unlock()` regardless of mute state, so the WebAudio context is ready when the user toggles audio on later in the game.
- **JSDOM audio degradation.** No `AudioContext` constructor exists in JSDOM. The module sniffs for it at startup and falls back to a no-op stub that still records the last requested effect on `__lastEffect` for test assertions.
- **Sprites cached as OffscreenCanvas where available.** `OffscreenCanvas` is preferred for the sprite cache; falls back to hidden `<canvas>` elements. Two variants per (type, owner): `clean` and `damaged` (HP < 50). Tinting is applied at bake time so per-frame draw is just a `drawImage`.
- **Damaged threshold = HP < 50.** Matches the existing damage tier the renderer uses elsewhere. The two extra dark strokes are very subtle — keeps the silhouette readable.
- **Editor brush palette.** Brushes are either `{ kind:'terrain', terrain }` or `{ kind:'owned', terrain:'hq'|'factory'|'city', owner }`. Right-click clears to plain. Validation runs through `loadMap` before download — if the painted map fails (e.g. missing HQ for a player) the error is surfaced inline and the download is blocked.
- **Editor only writes `tileLegend` + `tiles` + `units` + `players`.** No special "editor metadata" leaks into the map JSON. Round-tripping a loaded map through the editor produces a structurally equivalent file (key order may shift).
- **Map: island_hop.** 16×12. Two outer islands hold each player's HQ + factory + 2 cities. A central sea has two small islands with neutral cities. Copters bridge the gap (copter ignores ground terrain; sea passable only by air/sea movement classes). Loader test confirms tile counts + HQ positions.
- **Map: canyon.** 14×10. Long central mountain spine forces both players around either flank. Roads on the top and bottom edges; a contested neutral city in the middle plain. Tier3 vs Tier1 tournament terminates cleanly (3-0 in the verification run).
- **Camera shake threshold = 40 HP.** Pop-up at ~half-HP one-shot kills (tank-on-tank, artillery-on-tank). Cheap visual cue without being annoying.
- **Bundle size.** Final gzipped bundle is **26.10 KB**, well under the 250 KB budget. Sprites/audio/animation polish/editor add roughly ~20 KB raw / ~5 KB gzipped over Phase 5.
- **Death particles deterministic per enqueue.** `createDeathParticles(random, count)` is pure — given a seeded RNG, the same particle field is produced. Useful if a future replay viewer wants to be visually identical to the live match.
- **HP tween non-blocking.** `enqueueHpTween` and `enqueueShake` run as parallel anims (don't push the cursor) so the main MOVE→ATTACK chain stays serial while bars and shake decay in the background.

## Phase 7 (persona iteration)

- **Crossroads finishability vs persona behaviour.** Even after tuning,
  `turtle vs economist` on crossroads/canyon stalemates the 200-turn cap
  in pilot rounds. Diagnosis from a sample log:
    - Both AIs hit `TIER3_UNIT_CAP = 12` units.
    - Once at cap, the build phase stops producing replacements.
    - Existing units fill the centre, neither side breaks through the
      forest belt because pushing into enemy territory raises
      `futureThreat` to a level that overwhelms `damageDealt`.
    - WAITs dominate (~1.7k WAITs in a 200-turn stalemate vs 16
      CAPTUREs).
  A "pusher" persona experiment would need either (a) the `objective`
  weight scaled even higher with a custom override that pushes infantry
  directly toward the enemy HQ (current tier3's frontline target is the
  hottest-threat tile, which is *defensive*, not "toward the HQ"), or
  (b) raising/removing `TIER3_UNIT_CAP` so the AI keeps building. Both
  are persona/engine tweaks rather than reducer changes.
- **Build policy `infantryFloor` semantics.** As implemented, the floor
  is a hard-prefer-infantry trigger as long as `myInfantryCount < floor`
  AND `unowned > 0`. A persona with `infantryFloor: 5` ends up spamming
  infantry on every factory until it reaches 5 infantry — meanwhile its
  `preferred` list (which may include tank or recon) never fires. That
  was the iter 4 economist bug. Considered changing the rule to "only
  prefer infantry when total unit count is also low" — left for a
  future iteration to keep the iter 5 personas stable.
- **Frontline objective target = hottest enemy-threat tile, not enemy
  HQ.** A consequence noticed during iteration: tier3 frontline units
  cluster around their OWN side of the threat hot zone (because hottest
  threatMap tile is where enemies project most damage — i.e., right at
  our line). They don't naturally march toward the enemy HQ. If a
  future persona wants HQ pressure, we'd need either a new role
  (`pusher`) or a per-persona objective-target override. Left as an
  open question rather than implemented because the spec said personas
  should sit on top of the existing role machinery without changing it.
- **Side balance was off in iter 1 (44.4/55.6 p0/p1).** Tightened to
  47/53 by iter 2 and held. Suspected cause: p0 always moves first, so
  in close matches a one-turn tempo can flip the outcome — but in
  decisive matches (which the personas mostly produce) the side bias is
  largely a function of which persona is on which side. The half-and-
  half side rotation in the round-robin matrix removes this bias from
  the per-pair stats.
- **Economist iter-4 no-op.** Identical pilot results vs iter 3 despite
  five weight changes. Documented in AI_TUNING.md as a learning — when
  a persona's defining behaviour is gated by its build policy, weight
  tweaks alone can't move the needle.
- **island_hop dropped from round-robin.** Sea-heavy map with no
  transports (and only one capturable per side reachable without a
  copter). All matchups degenerate into capture grinds with whoever
  builds a copter first walking to the enemy HQ. Re-include once
  transports land.
