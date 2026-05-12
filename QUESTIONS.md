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
