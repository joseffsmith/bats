# Plans

Self-contained briefs for features an agent (or a fresh human) can pick up
without context from the session that authored them. Each plan should be
read top-to-bottom and contain everything needed to execute and verify.

## Format

Each plan has these sections, in order:

- **Context** — what this is, why it matters, the acceptance bar.
- **Background reading** — file paths in dependency order. An agent should
  read these in order before writing code.
- **Current state** — what's already wired up; explicit so the agent doesn't
  re-implement existing pieces.
- **Approach** — design discussion. May call out decision points where the
  agent should confirm with the user before coding.
- **Tasks** — numbered, concrete, testable steps. Each task should be
  committable on its own.
- **UI verification** — copy-pasteable `npm run shoot -- …` commands the
  agent uses to inspect the UI when it can't observe the live game.
- **Acceptance** — testable success conditions.
- **Out of scope** — explicit non-goals so scope doesn't creep.
- **Files you will likely touch** — final orientation.

## Active plans

- [`amphibious-ai.md`](amphibious-ai.md) — teach the AI to use transports,
  landers, carriers, and submarines, so `armada` and `island_hop` become
  contested games.
- [`fog-of-war.md`](fog-of-war.md) — per-player visibility, hidden-tile mask,
  enemy units invisible in fog, AI under imperfect information.

## UI feedback for agents

Most plans need to verify how the change looks, not just whether tests pass.
Agents can't run the dev server interactively, so the project ships
`npm run shoot` — a puppeteer-driven screenshot tool that spawns its own
isolated Vite instance and writes a PNG.

```sh
# Start state of a specific map:
npm run shoot -- --map=armada --out=/tmp/armada.png

# After 10 turns of AI-vs-AI:
npm run shoot -- --map=duel --p0=aggressor --p1=balanced --turn=10 \
  --out=/tmp/duel-10.png

# Arbitrary URL (use this when your feature adds a new param):
npm run shoot -- --url='http://localhost:5179/?map=highlands&fog=on' \
  --out=/tmp/fog.png
```

Flags: `--out` (required), `--map`, `--p0`/`--p1`, `--turn`, `--width`,
`--height`, `--url`, `--port`, `--wait-ms`. See `scripts/shoot.ts` for
defaults.

Workflow: shoot → Read the PNG (Claude is multimodal) → decide if the visual
is right → iterate. Don't claim a UI task is done without a shoot to back
the claim.
