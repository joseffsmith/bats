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

_None._
