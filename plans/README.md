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

## Working in a worktree

Every plan should be executed in its own git worktree off `main`, so the
parent checkout stays clean and reviewable, and parallel work doesn't
collide. From the repo root:

```sh
# Branch off main and check it out alongside the repo:
git worktree add ../bats-<feature> -b <feature>/<short-slug>
cd ../bats-<feature>
```

**Make the game runnable inside the worktree.** Vite, puppeteer, and tsx
all need to resolve through `node_modules`, which a fresh worktree does
not have. Two options, in order of preference:

1. **Symlink** the parent repo's `node_modules` — instant, no extra disk:
   ```sh
   ln -s ../bats/node_modules .
   ```
   Works as long as `package.json` in the worktree hasn't diverged from
   the parent. If your plan adds a dep, switch to option 2.

2. **`npm install`** in the worktree — adds ~5min and ~600MB (puppeteer
   bundles its own Chromium). Use this when you're touching `package.json`.

Verify the worktree is wired up:

```sh
npm test                                          # all 367+ tests pass
npm run shoot -- --map=duel --out=/tmp/wt.png     # screenshot writes
```

**Port conflicts.** `npm run shoot` defaults to port 5179 with strict-port,
so if you have a `npm run dev` going elsewhere or another worktree
mid-shoot, pass `--port=5180` (or any free port) to avoid the collision.

**Cleanup when the work merges.** Delete the worktree and branch when done:

```sh
cd /Users/joesmith/Code/bats
git worktree remove ../bats-<feature>
git branch -d <feature>/<short-slug>      # safe; refuses if unmerged
```

If you forget, `git worktree list` will show you all live worktrees.

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
