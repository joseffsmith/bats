# AI Persona Tuning Log

A round-by-round account of persona weight changes and tournament results.
Each iteration runs 10 matches / pair / map (pilot, fast) or 50 matches
/ pair / map (final) across `duel, crossroads, canyon` and writes the
full report under `logs/round-robin-iter<N>/`. `island_hop` is excluded
because of the central sea barrier — no transports yet → grindy capture
contests, not informative.

Stop condition: every persona has ≥10% win rate vs every other persona
on every map (well-rounded ideal), OR 5 iteration rounds, whichever
comes first.

---

## Runbook — how to change the AI

Three instruments, three different questions. All three run on every change:

- **Tournaments measure BALANCE** — who beats whom. Blind to flaws every
  persona shares: the iteration-8 cowardly-defender bug survived 1400+
  self-play matches because all four personas fled the same way, so the win
  rates never moved.
- **Doctrine tests measure INTENT** — does a unit do the obviously-right thing
  in a hand-built position, regardless of who wins the game.
- **Replay mining measures REALITY** — the degenerate patterns a scoreboard
  averages away.

That iteration-8 bug arrived as one sentence from live play ("balanced parked a
unit in the corner while its factory was captured") and was diagnosed in about
twenty minutes: fetch the replay → reproduce as a `makeState` scenario → run
with `ai-trace` → read the guilty term off the per-component breakdown
(defender `futureThreat` ×3). That loop is the standard, below.

### 1. The debug loop (trace-first)

For any "the AI felt off" report:

**a. Fetch the game.** Live games auto-upload their JSONL to
`https://bats.joseffsmith.uk/api/replays` on game end.

```
npm run replay -- --latest                   # newest production capture
npm run replay -- logs/<file>.jsonl          # a local log
npm run replay -- <name>.jsonl --remote      # a specific production capture
npm run replay -- --latest --dump 240        # print the state after action 240
```

`--dump N` gives the exact board the player saw. A winner/turn mismatch on
replay means the engine drifted since the game was played — check out the
header's `sha` first.

**b. Identify the suspect turn and unit**, then **reproduce it as a
micro-position**: build the smallest board that still shows the behaviour with
`makeState` (`tests/test-helpers.ts`) and drive it with
`personaAI(name).takeTurn({ state, player, rng: createRng(1) })`. Copy the
pattern in `tests/ai-defense.test.ts` — that file IS the iteration-8 repro.

**c. Trace it.** Per-candidate, per-component score dumps:

```
npx tsx src/cli/run-match.ts --map <map> --seed <seed> \
  --p0 <persona> --p1 <persona> --quiet --trace=5 > /tmp/trace.txt
```

`--trace=K` emits the top-K scored candidates per unit per turn, each with its
`parts` breakdown: `damageDealt`, `capture`, `counterRisk`, `futureThreat`,
`positional`, `objective` (plus `naval` / `defense` / `unload.*` where they
apply). The dominating term on the wrong candidate names the lever. The stream
is very noisy — redirect and grep; `--quiet` silences the per-action match log
so only the trace remains.

**d. Fix ONE lever**, then §2. Two levers at once and the pre/post table tells
you nothing about either.

### 2. Baseline discipline

**No scoring or weight change lands without a same-harness pre/post pair.** Run
the standard pilot before the change and again after:

```
npx tsx src/cli/round-robin.ts \
  --personas aggressor,turtle,economist,balanced \
  --maps duel,crossroads,canyon \
  --matches 10 --max-turns 120 \
  --out logs/rr-iter<N>-<pre|post>
```

Seeds are deterministic (fnv1a of pair/map/index/salt), so an unchanged field's
pre-table equals the previous iteration's post-table — if it doesn't, something
moved that you didn't intend to move. `--seed-salt` re-rolls deliberately;
never use it to make a bad result go away.

Every change gets a numbered `## Iteration N` entry here in the iteration-8
shape: **Trigger** (what prompted it, through which channel) → **Changes**
(file-by-file, one lever per bullet) → **Results** table with pre/post/Δ
columns → **Interpretation** (including which regressions are the fix working)
→ **Known non-regressions** verified present in the pre-run →
**Next-iteration candidates**.

Comparing against a months-old iteration run under different harness settings
is **forbidden** — a different `--matches`, `--max-turns` or map set means the
numbers aren't comparable. That is how false conclusions ship.

### 3. The three measurement layers

**(a) Doctrine tests — intent.**

```
npx vitest run tests/ai-doctrine.test.ts
```

Behavioural micro-positions asserting on action properties (types, targets,
distance deltas), never exact moves. **A new bug gets its scenario committed
BEFORE the fix** — red first, then green, so the test is proven to catch it.

**(b) Probe gate — floor against degenerate opponents.**

```
npx tsx scripts/probe-gate.ts
```

Every persona must win ≥70% against each scripted probe: `probe-rush`,
`probe-camper`, `probe-kiter`. Probes are deliberately stupid; losing to one is
never a playstyle, it's a bug.

**(c) Cross-generation check — frozen benchmarks.**

The iteration-8 field is frozen as `aggressor-i8` / `turtle-i8` /
`economist-i8` / `balanced-i8` (`src/data/ai-benchmarks/i8.json`, frozen at
`aff447e`). Round-robin the current personas against it:

```
npx tsx src/cli/round-robin.ts \
  --personas aggressor,turtle,economist,balanced,aggressor-i8,turtle-i8,economist-i8,balanced-i8 \
  --maps duel,crossroads,canyon --matches 10 --max-turns 120 \
  --out logs/rr-iter<N>-crossgen
```

No persona may regress more than 10 pp against its own `-i8` self without an
explicit justification in the iteration entry. Absolute win rates drift as the
whole field moves; the `-i8` field does not. (28 pairs — drop to `--matches 6`
if the wall-clock hurts.)

**(d) Replay mining — reality.**

```
npx tsx scripts/mine-replays.ts --dir logs/rr-iter<N>-post
npx tsx scripts/mine-replays.ts --remote
```

Degeneracy flags: uncontested capture, stalled/oscillating units, turn-cap
hits, held-lead-no-win. Run it on the pilot output every iteration and on
production replays periodically. Every hit names a JSONL you can re-open with
`npm run replay -- <name>.jsonl --remote` — back to §1.

> The probe gate, benchmarks and miner ship in parallel packages (WP1–WP3);
> exact flags are synced at Merge Gate 1.

### 4. Known flake

`tests/ai-tier3-vs-tier1.test.ts` asserts a 200 ms per-turn wall-clock budget.
It is load-sensitive: **never run vitest concurrently with a round-robin
pilot** — the pilot saturates the cores and the budget assertion fails
spuriously. A solitary timing failure under load is the known flake (re-run the
file alone to confirm); a **win-rate** failure in the same file is real and
blocks.

### 5. Campaign coordination

The campaign branch pins personas **by name** — turtle (m1), balanced (m2),
economist (m3), aggressor (m4), balanced (m5) — assuming the difficulty ramp
**turtle < balanced < economist < aggressor**.

Frozen contract; breaking any of these hard-fails the campaign loader:

- Persona keys in `src/data/ai-personas.json` are never renamed or removed.
- `personaAI(name, { fog })` and `PERSONA_NAMES` signatures are frozen.
- Probes and benchmarks must never enter `PERSONAS` / `PERSONA_NAMES`.

**Every persona-weight change silently shifts campaign mission difficulty.**
No campaign code notices; the missions just get easier or harder. So any
iteration entry touching `ai-personas.json` MUST end with a **Campaign impact**
line giving the new 4×4 land-map matrix ordering and whether the ramp holds:

> **Campaign impact.** Land-map ordering after this change: economist 77.8% >
> turtle 50.0% > aggressor 38.9% > balanced 33.3%. Intended ramp (turtle <
> balanced < economist < aggressor) does NOT hold — missions 1 and 4 are
> inverted in difficulty. Flagged for iteration N+1.

If the ramp breaks and your package doesn't own fixing it, say so explicitly
rather than leaving the matrix for someone else to interpret.

---

## Iteration 1 — baseline (pilot, 10 matches × 3 maps)

**Configuration (initial guess from spec):**

| persona   | damageDealt | capture | counterRisk | futureThreat | positional | objective | buildPolicy                                       |
|-----------|-------------|---------|-------------|--------------|------------|-----------|---------------------------------------------------|
| aggressor | 1.6         | 0.6     | 0.35        | 0.2          | 0.5        | 0.8       | preferred=[tank,recon,tank], avoid=[artillery]    |
| turtle    | 0.9         | 1.4     | 1.2         | 1.0          | 0.7        | 0.5       | preferred=[artillery,infantry,tank], avoid=[recon] |
| economist | 0.7         | 2.4     | 1.0         | 0.8          | 0.4        | 1.0       | preferred=[infantry,infantry,recon], avoid=[copter] |
| balanced  | 1.0         | 1.5     | 0.8         | 0.5          | 0.3        | 0.6       | (default builds)                                  |

**Results (180 matches, 10/pair/map):**

| persona   | W  | L  | D | WR    |
|-----------|----|----|---|-------|
| aggressor | 75 | 15 | 0 | 83.3% |
| balanced  | 70 | 20 | 0 | 77.8% |
| turtle    | 35 | 55 | 0 | 38.9% |
| economist |  0 | 90 | 0 |  0.0% |

Matrix (row vs col WR%):

|           | aggressor | turtle | economist | balanced |
|-----------|-----------|--------|-----------|----------|
| aggressor | -         | 100%   | 100%      | 50%      |
| turtle    | 0%        | -      | 100%      | 17%      |
| economist | 0%        | 0%     | -         | 0%       |
| balanced  | 50%       | 83%    | 100%      | -        |

Side balance: p0=44.4% / p1=55.6% — small skew, acceptable.

**Observations:**

1. **Economist is critically broken** — 0/90. Capture-heavy + low damage means
   it doesn't kill anything; it just walks infantry forward to be slaughtered.
   The cheap-infantry build policy starves it of any unit that can fight back.
2. **Aggressor and balanced are nearly tied** at the top. The 100% wins over
   turtle/economist hides that they only manage 50/50 against each other.
3. **Stalemates** on `turtle vs economist` (crossroads + canyon → 201 turns),
   `turtle vs balanced` on duel + crossroads. Both involve turtle — fixed
   defensive posture won't push to finish.
4. **Crossroads finish issue**: visible. 10/10 `turtle vs balanced` matches
   on crossroads hit the cap. Tier3 tournament adjudication is masking it.

**Planned tuning for iteration 2:**

- Economist: bump `damageDealt` 0.7 → 1.0; lower `capture` 2.4 → 1.8; add
  `recon`/`tank` to preferred; lower `infantryFloor` 5 → 3.
- Turtle: more offence: `damageDealt` 0.9 → 1.1, `objective` 0.5 → 0.8,
  preferred=[artillery,tank,infantry], `infantryFloor` 4 → 3.
- Aggressor: nerf: `damageDealt` 1.6 → 1.4, `counterRisk` 0.35 → 0.5.
- Balanced: control, unchanged.

---

## Iteration 2 — small retune (pilot, 10 matches × 3 maps)

**Results (180 matches):**

| persona   | W  | L  | D | WR    |
|-----------|----|----|---|-------|
| aggressor | 85 |  5 | 0 | 94.4% |
| balanced  | 65 | 25 | 0 | 72.2% |
| turtle    | 25 | 65 | 0 | 27.8% |
| economist |  5 | 85 | 0 |  5.6% |

Matrix (row vs col WR%):

|           | aggressor | turtle | economist | balanced |
|-----------|-----------|--------|-----------|----------|
| aggressor | -         | 100%   | 100%      | 83%      |
| turtle    | 0%        | -      | 83%       | 0%       |
| economist | 0%        | 17%    | -         | 0%       |
| balanced  | 17%       | 100%   | 100%      | -        |

Side balance: 50.0% / 50.0% — restored.

**Observations:**

- Aggressor got STRONGER, not weaker. The lower damageDealt was offset by
  the more aggressive build mix and lower counterRisk vs balanced.
- Turtle's bump to damage+objective didn't help — turtle still walls up
  with artillery and stalls (aggressor vs turtle duel + crossroads still
  hit 201 turns despite turtle losing 10/10).
- Economist scored its first wins (5 vs turtle on duel) — building a recon
  + tank gave it something with which to bite.
- Stalemates: still seven 201-turn matchups. The crossroads finish problem
  is now in turtle-vs-aggressor too.

**Planned tuning for iteration 3:**

- Aggressor: real nerf. `damageDealt` 1.4 → 1.2, `counterRisk` 0.5 → 0.7,
  preferred [tank,recon,infantry], `infantryFloor` 2 → 3.
- Turtle: less artillery, more tanks. preferred=[tank,infantry,artillery].
- Economist: more teeth. preferred=[infantry,tank,recon].
- Balanced: still the control.

---

## Iteration 3 — narrower archetypes (pilot, 10/pair/map)

**Results (180 matches):**

| persona   | W  | L  | D | WR    |
|-----------|----|----|---|-------|
| turtle    | 70 | 20 | 0 | 77.8% |
| aggressor | 65 | 25 | 0 | 72.2% |
| balanced  | 45 | 45 | 0 | 50.0% |
| economist |  0 | 90 | 0 |  0.0% |

Matrix:

|           | aggressor | turtle | economist | balanced |
|-----------|-----------|--------|-----------|----------|
| aggressor | -         | 33%    | 100%      | 83%      |
| turtle    | 67%       | -      | 100%      | 67%      |
| economist | 0%        | 0%     | -         | 0%       |
| balanced  | 17%       | 33%    | 100%      | -        |

Side balance: 47.2 / 52.8.

**Observations:**

- BIG improvement: turtle and aggressor are now distinct archetypes that
  trade wins. Turtle 67% on duel + canyon, but aggressor wins crossroads
  100%. That's the kind of map-driven asymmetry we want.
- Balanced settles at exactly 50% — a sensible control.
- Economist is still 0/90. The damage/capture mix isn't enough; capture
  doesn't pay off if the unit dies before flipping the tile.
- Stalemates dropped substantially. `turtle vs balanced crossroads` 167
  avg, `aggressor vs balanced crossroads` 122 avg — still long but no
  longer all 200-cap. Only `aggressor vs turtle crossroads 100%` looks
  decisive.

**Planned tuning for iteration 4:**

- Economist: defensive rework. damage 0.8, counterRisk 1.6, futureThreat 1.2,
  objective 1.4, infantryFloor 5.

---

## Iteration 4 — defensive economist (pilot, 10/pair/map)

Results are **byte-identical to iter 3**:

| persona   | W  | L  | D | WR    |
|-----------|----|----|---|-------|
| turtle    | 70 | 20 | 0 | 77.8% |
| aggressor | 65 | 25 | 0 | 72.2% |
| balanced  | 45 | 45 | 0 | 50.0% |
| economist |  0 | 90 | 0 |  0.0% |

**Observations:**

- Same scoreboard means the defensive changes had **zero net behaviour
  difference**. Inspecting `aggressor-vs-economist-duel` logs: economist
  build-spams infantry on every turn (it has `infantryFloor=5` and never
  drops below 2 infantry, so the floor keeps firing, never reaching the
  tank in `preferred`).
- The build-policy logic uses `myInfantryCount < infantryFloor` as a
  HARD-PREFER-infantry trigger. That's the bug: floor should trigger only
  if we ALSO have low total units, otherwise our 7th infantry slot still
  spawns infantry instead of a tank.
- For this tuning round we'll fix the bug indirectly with persona
  configuration — drop `infantryFloor` to 2, put `tank` first in preferred.

**Planned tuning for iteration 5:**

- Economist: pivot. damage 0.8→1.0, counterRisk 1.6→0.9, futureThreat
  1.2→0.6, objective 1.4→1.2; capturer override 4.0→4.5, counterRisk
  2.0→1.4; buildPolicy floor 5→2, preferred=[tank,infantry,recon,infantry].
- Aggressor / turtle / balanced: unchanged.

---

## Iteration 5 — economist as swarm-with-tank (pilot, 10/pair/map)

**Results (180 matches):**

| persona   | W  | L  | D | WR    |
|-----------|----|----|---|-------|
| economist | 70 | 20 | 0 | 77.8% |
| aggressor | 45 | 45 | 0 | 50.0% |
| turtle    | 45 | 45 | 0 | 50.0% |
| balanced  | 20 | 70 | 0 | 22.2% |

Matrix:

|           | aggressor | turtle | economist | balanced |
|-----------|-----------|--------|-----------|----------|
| aggressor | -         | 33%    | 33%       | 83%      |
| turtle    | 67%       | -      | 17%       | 67%      |
| economist | 67%       | 83%    | -         | 83%      |
| balanced  | 17%       | 33%    | 17%       | -        |

**Floor check:** Every persona has ≥17% win rate vs every other persona —
meets the **≥10% pairing floor**. Per-map asymmetry survives (turtle 0/10
vs aggressor on crossroads, but 10/10 on duel + canyon).

Side balance 52.8% / 47.2% — within noise.

**Observations:**

- Real four-way tournament. Economist climbed from 0% to 78% by lowering
  its infantryFloor to 2 and putting tank first in preferred — meaning
  the AI actually builds tanks once it has any infantry presence.
- Balanced becomes the weak archetype this round (22.2%). That's expected:
  the three tuned personas have explicit advantages; the control doesn't.
- **Crossroads finish issue partially resolved.** Earlier rounds had 5–7
  matches hitting the 200-turn cap; this round has 3 cap-stalemates only:
  - turtle vs economist on all three maps (duel 5/5, crossroads 0/10,
    canyon 0/10) — the matchup is the new pathological pairing because
    both personas have positional/capture biases.
  - aggressor vs economist crossroads (5/5, avg 196 turns).
- Turtle 0/10 on crossroads vs aggressor is the most lopsided per-map
  cell — but it's BALANCED by turtle winning duel and canyon 10/10. This
  is the map-driven asymmetry the spec asked for.

**Stop condition met** — five rounds run, ≥10% floor achieved on every
pair (though not every map). Final 25/pair/map verification tournament
in `logs/rr-final/` corroborates the iter 5 pilot.

---

## Final Personas (iter 5)

These are the tuned values committed to `src/data/ai-personas.json`:

```json
aggressor:
  weights:      damage=1.2 capture=0.9 counterRisk=0.7 futureThreat=0.3 positional=0.4 objective=0.9
  frontline ×:  damageDealt=1.5 counterRisk=0.8
  build:        preferred=[tank,recon,infantry] avoid=[artillery] floor=3

turtle:
  weights:      damage=1.0 capture=1.6 counterRisk=0.9 futureThreat=0.7 positional=1.0 objective=1.0
  defender ×:   futureThreat=3.0 positional=1.6 capture=0
  frontline ×:  damageDealt=1.1 positional=1.5
  build:        preferred=[tank,infantry,artillery] avoid=[recon] floor=3

economist:
  weights:      damage=1.0 capture=1.8 counterRisk=0.9 futureThreat=0.6 positional=0.5 objective=1.2
  capturer ×:   capture=4.5 counterRisk=1.4 objective=1.8
  frontline ×:  damageDealt=1.3 objective=1.2
  build:        preferred=[tank,infantry,recon,infantry] avoid=[copter] floor=2

balanced (control):
  weights:      damage=1.0 capture=1.5 counterRisk=0.8 futureThreat=0.5 positional=0.3 objective=0.6
  no role overrides, default builds
```

## Tournament results — iter 5 pilot (180 matches, 10/pair/map)

| persona   | W  | L  | D | WR    |
|-----------|----|----|---|-------|
| economist | 70 | 20 | 0 | 77.8% |
| aggressor | 45 | 45 | 0 | 50.0% |
| turtle    | 45 | 45 | 0 | 50.0% |
| balanced  | 20 | 70 | 0 | 22.2% |

| row\col   | aggressor | turtle | economist | balanced |
|-----------|-----------|--------|-----------|----------|
| aggressor | -         | 33%    | 33%       | 83%      |
| turtle    | 67%       | -      | 17%       | 67%      |
| economist | 67%       | 83%    | -         | 83%      |
| balanced  | 17%       | 33%    | 17%       | -        |

Side balance: 52.8% / 47.2%.

## Map-driven asymmetry (per-pair × per-map, A-wins / B-wins / draws)

| pair                  | duel | crossroads | canyon |
|-----------------------|------|------------|--------|
| aggressor vs turtle   | 0/10 | 10/0       | 0/10   |
| aggressor vs economist| 0/10 | 5/5        | 5/5    |
| aggressor vs balanced | 10/0 | 5/5        | 10/0   |
| turtle vs economist   | 5/5  | 0/10       | 0/10   |
| turtle vs balanced    | 10/0 | 0/10       | 10/0   |
| economist vs balanced | 10/0 | 5/5        | 10/0   |

Notable asymmetries:
- Turtle's positional weight makes it shine on the **forest-belt duel
  map** and **canyon-flanks** but it can't break the crossroads centre
  against aggressor (0/10).
- Aggressor's tank rush dominates the open **crossroads middle** but
  fails on duel/canyon when turtle holes up on terrain stars.
- Economist beats turtle on **crossroads + canyon** (10/10 each)
  because turtle's slow-push runs out of unit-cap headroom — economist
  outscales on captures.
- Balanced has no terrain or build advantage — explicitly the weak
  control archetype.

## Crossroads finish issue

**Diagnosis.** Sampling the iter 1 `turtle-vs-balanced-crossroads-000`
log (200-turn cap, no winner): both players at the `TIER3_UNIT_CAP =
12` unit ceiling early (~turn 80), and after that the BUILD phase no-
ops. Action distribution in the stalemate: 1779 WAIT (vs only 223
ATTACK, 16 CAPTURE, 132 BUILD across 200 turns). Units cluster at the
contested forest belt and refuse to push into the enemy half because
`futureThreat` rises sharply once they cross — the score for "advance"
turns negative.

**Resolution status.** The iter 5 personas substantially reduce the
problem:
- `turtle vs economist` crossroads still hits the cap (0/10 → 5/5 in
  adjudication) — this is the remaining pathological pairing.
- `aggressor vs balanced` crossroads gets to ~120 turns average,
  decisive 5/5.
- `aggressor vs turtle` crossroads finishes at ~110 turns with
  aggressor winning 10/10 — the explicit tank-rush persona beats the
  defensive one on the open map. That's the intended archetype
  asymmetry.

A "pusher" persona experiment (high `objective`, low `futureThreat`,
high-floor infantry to keep capturing) was implicitly tested through
iter 3's aggressor (low futureThreat=0.3, frontline×damageDealt=1.5).
It DOES break crossroads stalemates against turtle. But the same
persona is too lossy on duel/canyon — high futureThreat would
otherwise save its capturers from being run over. The fundamental
trade-off is `pushing toward enemy HQ` vs `living long enough to
matter`, and there isn't a single weighting that wins both. Worth
considering a future role refactor (a `pusher` role with
objective-target = enemy HQ rather than hottest-threat tile) — flagged
in `QUESTIONS.md`.

## Open questions

- See `QUESTIONS.md` for the full list of iteration-derived questions
  (frontline-target semantics, infantryFloor build-bug, future
  refactors).

---

## Iteration 6 — expanded roster (pilot, 6 matches × 6 maps)

Trigger: the unit roster expanded from 6 → 14 (added `fighter`, `bomber`,
`battleship`, `cruiser`, `aatank`, `lander`, `submarine`, `carrier`) and
two new maps landed (`highlands` air-focused; `armada` sea-focused). The
iter-5 personas' `preferred` build lists named only the original 4
ground unit types, so on the new maps the AI couldn't field anything
appropriate to the terrain. A baseline tournament confirmed: 59.7 %
match-stalemate rate, ALL six `armada` pairings ending in genuine draws
(no `rawWinner`), and zero builds of any new unit type by any persona.

### Baseline (216 matches, 6 maps × 6 pairs × 6 matches/pair)

| persona   | W  | L  | D  | WR    |
|-----------|----|----|----|-------|
| aggressor | 48 | 54 |  6 | 44.4% |
| balanced  | 33 | 69 |  6 | 30.6% |
| economist | 66 | 36 |  6 | 61.1% |
| turtle    | 57 | 45 |  6 | 52.8% |

- **Stalemates (no `rawWinner`): 129/216 = 59.7 %**
- **Genuine draws (adjudication tied): 12** — all on `armada`
- **Builds per persona per match (top types):**
  - aggressor: 6.6 tank, 5.6 recon, 3.3 infantry
  - turtle:    7.5 tank, 7.1 infantry, 0.0 of anything else
  - economist: 8.1 tank, 6.9 infantry, 0.0 of anything else
  - balanced:  5.4 tank, 5.6 recon, 3.6 infantry
- **Zero air or sea units built by any persona on any map.**

Sample log (`aggressor-vs-balanced-armada-000`): both sides ground-cycle
infantry/recon/tank on inland factories, with no path across the
central sea strip. Land units can't move onto sea tiles; sea-class
units aren't built because the personas don't list them. Result: 200
turns, zero engagement, adjudicated draw.

### Changes applied

**(a) Persona `preferred` list expansion.** Each persona learned about
one or two new unit types that match its archetype:

| persona   | preferred (round 6)                                          | avoid (round 6)                                                |
|-----------|--------------------------------------------------------------|----------------------------------------------------------------|
| aggressor | bomber, cruiser, tank, fighter, recon, infantry              | artillery, submarine, carrier, transport, lander               |
| turtle    | battleship, cruiser, aatank, tank, infantry, artillery       | recon                                                          |
| economist | cruiser, tank, infantry, recon, aatank, infantry             | copter, bomber, battleship, submarine, carrier, fighter, lander, transport |
| balanced  | cruiser, fighter, tank, recon, aatank, artillery, infantry   | —                                                              |

Rationale per persona:

- **aggressor** gets `bomber` (top of list) for huge anti-ground damage
  (95 vs recon, 100 vs tank, 110 vs infantry — bombers fly over the
  forest belt that traps tanks on crossroads/highlands). `cruiser` is
  the coastal-factory fallback when bomber isn't legal/affordable.
  `fighter` provides air-superiority defence so we don't lose bombers
  to enemy fighters/copters. Submarine excluded because the AI doesn't
  yet operate DIVE/SURFACE (see open follow-ups).
- **turtle** gets `aatank` as a hard anti-air counter (105 dmg vs
  copter/bomber, 100 vs fighter) — directly counters aggressor's
  bombers. `battleship` + `cruiser` placed at the top so coastal
  factories produce sea defence; on inland factories these fall
  through to `tank`/`infantry`/`artillery`.
- **economist** stays cheap (`avoid` blocks the 14k bomber + 18k
  battleship + 22k carrier + 16k submarine). `cruiser` (11k) is its
  only sea option for armada; `aatank` is mid-cost defence. Transport
  units excluded because economist needs units that actually fight
  (the AI doesn't operate LOAD/UNLOAD).
- **balanced** acquires a representative mix: `cruiser` for sea,
  `fighter` for air, `aatank` for AA. No `avoid` list — pure control.

**(b) Coastal-factory build filtering in `enumerateBuilds`.** Naïvely
putting `cruiser` at the top of turtle's `preferred` list would emit a
guaranteed-illegal `BUILD` action on inland factories (`checkBuild`
rejects sea-class units that don't have an adjacent sea tile). The
top-level legality check in `planUtilityTurn` would drop the action,
wasting the factory's turn. Fixed by gating each preferred entry per
factory: a sea-class unit is skipped at the factory iff there is no
orthogonally-adjacent sea tile. The walker then falls through to the
next type in `preferred`. This is a one-function diff in
`src/engine/ai/utility.ts`; no engine semantics change.

**(c) No weight/role changes.** The persona role overrides and weights
from iter 5 carry over unchanged. We did NOT touch the utility scoring
or role multipliers; only the build-priority lists and the per-factory
legality filter. (A threat-class-match scoring bonus — e.g. "+X for
building a fighter when the enemy has copters" — was considered but
deferred. The persona-list change alone resolved most of the build
neglect; the residual stalemates are all driven by missing
amphibious / transport AI, not by misweighted scoring.)

### Tuned results (same conditions: 216 matches)

| persona   | W  | L  | D | WR    |
|-----------|----|----|---|-------|
| aggressor | 63 | 39 | 6 | 58.3% |
| economist | 60 | 48 | 0 | 55.6% |
| turtle    | 45 | 63 | 0 | 41.7% |
| balanced  | 42 | 60 | 6 | 38.9% |

Pairing matrix (row vs col WR%):

|           | aggressor | turtle | economist | balanced |
|-----------|-----------|--------|-----------|----------|
| aggressor | -         | 67%    | 67%       | 42%      |
| turtle    | 33%       | -      | 25%       | 67%      |
| economist | 33%       | 75%    | -         | 58%      |
| balanced  | 42%       | 33%    | 42%       | -        |

- **Stalemates: 108/216 = 50.0 % (-9.7 pp)**
- **Genuine draws: 6 (-50%)** — all six remaining are on `armada`
- Pair-win-rate **floor (≥10%) met on every pair.**

Per-map breakdown of stalemates by pair (each cell is N/6):

|                       | duel | crossroads | island_hop | canyon | highlands | armada |
|-----------------------|------|------------|------------|--------|-----------|--------|
| aggressor vs turtle   | 0/6  | 3/6 → 0/6  | 6/6        | 0/6    | 6/6 → 3/6 | 6/6    |
| aggressor vs economist| 0/6  | 6/6 → 0/6  | 6/6        | 0/6    | 3/6 → 3/6 | 6/6    |
| aggressor vs balanced | 0/6  | 6/6 → 6/6  | 6/6        | 3/6→0/6| 6/6 → 6/6 | 6/6    |
| turtle vs economist   | 0/6→3/6 | 3/6→0/6 | 6/6        | 3/6→0/6| 3/6 → 3/6 | 6/6    |
| turtle vs balanced    | 0/6  | 3/6 → 0/6  | 6/6        | 0/6→3/6| 3/6 → 3/6 | 6/6    |
| economist vs balanced | 0/6  | 3/6 → 0/6  | 6/6        | 0/6    | 6/6 → 3/6 | 6/6    |

Arrow `→` shows baseline → tuned where the cell changed; static cells
were the same in both runs.

Highlights:

- **Crossroads now decisive everywhere except `aggressor vs balanced`.**
  Bombers/fighters break the forest-belt stalemate that defeated iter
  5's pure tank push. Aggressor wins crossroads 6/0 vs turtle by
  bombing infantry stacks; the bomber-vs-fighter clashes resolve
  decisively.
- **Highlands halved its stalemate rate.** Was 4 of 6 pair-cells
  capped; now 2 are clean and the rest are 3/6 mixed. The lone hold-
  out is `aggressor vs balanced highlands`: both build heavy air
  rosters (aggressor's 9.2 bomber + 7.8 tank, balanced's 9.8 fighter
  + 5.3 tank) and trade interceptions without either reaching the HQ.
- **Armada and island_hop are unchanged: 100 % cap-stalemate.** Both
  maps require amphibious operations the AI can't yet stage —
  transports/landers must LOAD an infantry, ferry across the sea, and
  UNLOAD onto enemy land. The utility AI doesn't generate
  LOAD/UNLOAD candidates at all (`candidates.ts` enumerates only
  ATTACK/CAPTURE/WAIT follow-ups). With the round-6 build changes,
  the sea action at least HAPPENS — cruisers fight cruisers,
  bombers/fighters trade — but neither side can reach the enemy HQ
  to win.

### Build composition in tuned run (avg per match)

| persona   | aatank | bomber | fighter | infantry | recon | tank |
|-----------|--------|--------|---------|----------|-------|------|
| aggressor |  0.0   |  3.3   |  0.0    |  3.7     | 5.8   | 3.5  |
| balanced  |  0.0   |  0.0   |  3.4    |  4.0     | 7.8   | 2.8  |
| economist |  0.0   |  0.0   |  0.0    |  7.3     | 0.0   | 6.9  |
| turtle    |  6.3   |  0.0   |  0.0    |  7.2     | 0.0   | 1.4  |

Map-level: aggressor's bombers concentrate on highlands (9.2/match)
and crossroads (6.5/match); fighters on highlands for balanced
(9.8/match). Turtle's aatank explodes on highlands (11.0/match) and
crossroads (13.0/match) as a direct counter to enemy air. The
deferred-integration units (`submarine`, `carrier`, `lander`,
`battleship`) saw zero builds in this run — partly because they're
expensive enough that the greedy build picker never accumulates the
necessary funds (the cheaper preferred entry above always fires
first), and partly because they're in `avoid` lists for personas
where they don't fit. Acceptable: the goal was making the AI build
SOMETHING useful for the new maps, not exercising every roster slot.

### Open follow-ups

- **Submarine DIVE/SURFACE.** `QUESTIONS.md` already flags this. Until
  `generateCandidates` yields DIVE/SURFACE follow-ups and the threat
  map / value map understand stealth, submarines are deliberately on
  every persona's `avoid` list. Re-enable once integrated.
- **Carrier + air cargo.** Carriers carry fighters/bombers across sea.
  Without LOAD/UNLOAD candidates the carrier is a dead unit. Avoided
  by every persona.
- **Transport / lander (amphibious push).** The core blocker for
  `armada` and `island_hop`. The fix is non-trivial: the AI needs to
  recognise "my infantry can't capture the central neutral cities
  unless I ferry them across" and route an infantry into a transport,
  the transport across the sea, and UNLOAD it on the right tile. This
  is a structural change in `candidates.ts` + `roles.ts` and is out
  of scope for round 6.
- **Battleship neglect.** Turtle lists `battleship` first but its 18k
  cost means the greedy build picker fires on `cruiser` (11k) before
  funds ever accumulate to 18k. Could add a "save up" flag to the
  build policy for one factory per turn. Deferred — battleships are
  nice-to-have, not load-bearing.
- **Highlands `aggressor vs balanced` cap-stalemate.** Both personas
  now field heavy air rosters that perfectly counter each other,
  producing a slow attritional trade with no HQ-pressure. Possible
  fix: a `pusher` role multiplier specifically for air units that
  marches them toward the enemy HQ. Deferred — it's a single
  remaining pair-cell, and the bigger win (resolving the 50% rate
  itself) is achieved.

### Stop condition

Tuned run meets the iter 5 quality bar (≥10% floor every pair). The
overall stalemate rate dropped 9.7 percentage points and the genuine-
draw count halved. Two-thirds of the residual cap-matches are on the
two sea-heavy maps (`armada`, `island_hop`), which are blocked on
amphibious-AI integration rather than persona tuning. Round 6 closed.

---

## Fog-of-war: AI under imperfect information

Shipping behind `?fog=on`. When enabled, the AI is handed
`viewStateForPlayer(state, ai.player)` in place of the truth: a
shallow-cloned state where hidden enemies are stamped with a
`loadedIn` sentinel (`FOG_HIDDEN_SENTINEL`), so existing skip-logic
in `attackableTargets`, `unitAt`, `computeThreatMap`, and pathfinding
masks them — but `checkWinner` still counts them so the AI's
simulated `reduce()` calls don't trigger spurious rout-wins on every
plan step.

A small phantom-threat baseline (`PHANTOM_THREAT_PER_HIDDEN_TILE = 2`
in `utility.ts`) is overlaid onto the threat map for hidden tiles, so
the AI is mildly biased toward scouting before committing.

### Acceptance numbers

- `tests/fog-acceptance.test.ts`: tier3 (fog) vs tier1 (fog) on duel
  with seeds 1..10 — **≥7/10** wins for tier3. Matches the no-fog
  acceptance bar in `tests/ai-tier3-vs-tier1.test.ts`.
- `tests/fog-of-war.test.ts`: vision-disk matrix (per unit type) and a
  determinism check (utility-vs-utility with the same seed produces
  identical traces under fog).

### Tuning knobs

- `visionRange` per unit type in `src/data/units.json` — recon 5,
  copter 5, fighter 5, cruiser 5, infantry 2, etc.
- `PHANTOM_THREAT_PER_HIDDEN_TILE` in `src/engine/ai/utility.ts` — at 12
  the AI paralyzed (refused to move into any fog tile); at 2 it scouts
  appropriately without freezing.

## Iteration 7 — amphibious AI (216 matches, 6 maps × 6 pairs × 6)

Trigger: round 6 left `armada` and `island_hop` 100 % cap-stalemate
because the candidate generator never yielded `LOAD`/`UNLOAD`/`DIVE`/
`SURFACE`. The personas were able to BUILD ships but had no way to
move infantry across water or operate submarines/carriers. Plan:
`plans/amphibious-ai.md`.

### Changes applied

**(a) Candidate generator (`src/engine/ai/candidates.ts`).**
- `generateCandidates` now emits a `LOAD` candidate when a cargo-class
  unit's reachable set includes a friendly transport's tile (the
  pathfinder already treats a boardable transport as a terminal node;
  we just dispatch `LOAD` instead of `MOVE` for that destination).
- `yieldFollowUps` adds three new follow-ups:
  - `DIVE` / `SURFACE` for submarines (toggles the stealth flag);
    legal both stay-put and after MOVE.
  - `UNLOAD` for any transport with cargo aboard — enumerates the
    four neighbouring tiles of the (possibly post-MOVE) transport
    position, one candidate per `(cargo × destination)` pair.
- The validator gates every emitted candidate; no semantic
  duplication.

**(b) Scoring (`src/engine/ai/utility.ts`).**
A switch at the top of `scoreAction` routes the new follow-ups to
dedicated scorers; the generic damage/capture/counter-risk weights
return ~0 for these actions and would have produced garbage:
- `scoreDive`: `+5 + threatMap[cell]*0.1` when a spotter (enemy
  cruiser/submarine) is NOT adjacent and the cell is threatened. `-2`
  when a spotter would un-mask the dive, `-1` when the cell is safe.
- `scoreSurface`: `+4` when an attackable enemy is adjacent and no
  spotter is, `-3` otherwise (staying hidden has value).
- `scoreLoad`: `+2 + 0.5*Δ` where Δ is `manhattan(cargo, enemyHQ) -
  manhattan(transport, enemyHQ)`. Negative when the transport is
  farther from the goal than the cargo — suppresses the "load now,
  unload right back where I started" antipattern.
- `scoreUnload`: `+4` base, plus distance-to-enemy-HQ pull, plus a
  large bonus when the drop tile is ON or NEXT TO an unowned
  capturable (extra +8 if it's the enemy HQ), minus a threat-map
  penalty so we don't drop cargo into a kill zone.

**(c) Unit-processing order (`orderedOwnedUnits`).**
Potential carriers (`cargoCapacity > 0`) now sort AFTER potential
cargo. Without this, the cost-desc tiebreak put the 5000-cost
transport ahead of the 1000-cost infantry it should carry — the
transport spent its turn moving while the infantry's `LOAD`
candidate window closed. Land-only maps are unaffected (no unit on
those maps has `cargoCapacity > 0`).

**(d) Persona `avoid` cleanup.** With the AI now operating amphibious
units, the round-6 "AI can't drive this — don't build it" entries
came off the relevant `avoid` lists:

| persona   | round-6 avoid                                                              | round-7 avoid                  |
|-----------|----------------------------------------------------------------------------|--------------------------------|
| aggressor | artillery, submarine, carrier, transport, lander                           | artillery, carrier             |
| economist | copter, bomber, battleship, submarine, carrier, fighter, lander, transport | copter, bomber, battleship, submarine, carrier, fighter |
| turtle    | recon                                                                      | recon                          |
| balanced  | —                                                                          | —                              |

`preferred` lists are intentionally unchanged (an earlier draft that
promoted `submarine`/`transport` into preferred caused the build
picker to waste funds on boats the persona didn't need; reverted).
Amphibious play in round 7 uses the STARTING boats each map ships
with, not newly-built ones.

### Tests

- `tests/ai-amphibious.test.ts` (new) — 11 tests covering candidate
  enumeration (DIVE/SURFACE/LOAD/UNLOAD), tactical scoring (AI dives
  a sub when an unreachable artillery threatens it, AI loads an
  idle infantry next to a transport, AI unloads near an enemy
  capturable), and a smoke test that confirms zero illegal actions
  across an armada turn for the balanced persona.
- Full suite: 379 / 379 passing in the post-merge run. The Tier-3
  perf-budget test (`tier3 vs tier1 ≥7/10 on crossroads`) was the
  pre-existing intermittent flake at the 200 ms ceiling; my changes
  did not regress turn-time vs main.

### Tournament results (216 matches, 6 maps × 6 pairs × 6 matches)

| persona   | W  | L  | D | WR    | Δ vs r6 |
|-----------|----|----|---|-------|---------|
| aggressor | 69 | 39 | 0 | 63.9% | +5.6 pp |
| economist | 69 | 39 | 0 | 63.9% | +8.3 pp |
| balanced  | 42 | 66 | 0 | 38.9% |  0     |
| turtle    | 36 | 72 | 0 | 33.3% | −8.4 pp |

Pairing matrix (row vs col, % win for row):

|           | aggressor | balanced | economist | turtle |
|-----------|-----------|----------|-----------|--------|
| aggressor | -         | 42%      | 75%       | 75%    |
| balanced  | 58%       | -        | 33%       | 25%    |
| economist | 25%       | 67%      | -         | 100%   |
| turtle    | 25%       | 75%      | 0%        | -      |

- **Genuine draws (adjudication tied): 0** — was 12 in round 6
  baseline, 6 after round-6 tuning. The new code resolves every
  match decisively.
- **Cap-stalemate cells (avgTurns ≥ 200, all 6 matches in a cell
  hit the cap): 14 / 36** (vs round-6's 14). Distribution:
  - `armada`: 6 / 6 cells (was 6 / 6)
  - `island_hop`: 6 / 6 cells (was 6 / 6)
  - `highlands`: 1 / 6 (aggressor vs balanced — unchanged from r6)
  - `crossroads`: 1 / 6 (aggressor vs balanced — unchanged)
  - `duel`, `canyon`: 0 / 6 each (unchanged)

  So the cap-cell count is identical, but ALL cap-cells now resolve
  to a tie-break winner instead of producing genuine 1-1 draws.

- **Pair-win-rate floor (≥10%):** **regression.** `economist vs
  turtle` went from 25 % → 0 % (turtle lost all 36 matches).
  Investigation: every loss is on a sea-heavy map (armada,
  island_hop) where economist's swarm successfully ferries to enemy
  land, but turtle's `defender.capture: 0` role override keeps its
  defending infantry from reciprocating — turtle's HQ-side units
  sit and trade, never marching. This is a turtle-tuning issue, not
  an amphibious issue (turtle vs economist on the four land maps is
  6-0 economist too, same as round 6 — the regression is just that
  the previously-stalemated sea maps now decisively favour
  economist).

### Visual verification

`npm run shoot -- --map=armada --p0=balanced --p1=aggressor --turn=12`
and the matching `island_hop` shot (see `plans/amphibious-ai.md` for
the exact commands) confirm:
- transports / landers are off their starting tiles by turn 12
- infantry are placed on previously-unreachable central / enemy
  islands
- the city counter has moved for both players (was static through
  the entire 200 turns in round 6 on these maps)

### Open follow-ups

- **`economist vs turtle` floor.** Turtle's `defender.capture: 0` plus
  its preference for land-only builds (`avoid: [recon]`) means it
  never threatens economist's home side on sea maps; economist's
  ferried infantry capture cities uncontested. Fix candidates:
  loosen `defender.capture` to a non-zero multiplier on sea maps,
  or give turtle a positive amphibious-build leaning. Both are
  scope-creep for round 7 — flagged for round 8.
- **Cap-stalemate on armada / island_hop.** Genuine draws are gone
  but matches still hit the 200-turn cap because: (a) the AI ferries
  cargo but doesn't strongly target the enemy HQ tile vs nearby
  cities; (b) once both sides have captured the central neutral
  cities, the trade-and-attrit phase doesn't terminate. The
  `scoreUnload` HQ-bonus is +8 but the AI tends to drop on the
  nearer enemy city instead. Possible fix: a `pusher`-role override
  for unloaded infantry that targets the enemy HQ over local
  capturables.
- **Submarine usage is rare.** Without a clearly-threatened sub on
  the standard armada start, the DIVE branch only fires
  opportunistically. The starting submarines DO surface-and-attack
  enemy cruisers/battleships when in range, but they spend most of
  the early game just patrolling. Not bad, but the stealth
  mechanic is underused.
- **Carriers idle.** No persona starts with a carrier (only
  `armada` ships a battleship + cruiser + submarine + transport
  per side); carriers only exist if BUILT, which currently
  doesn't happen. Carrier exercising is blocked on a map that
  ships one and on a build-policy that includes them — both are
  follow-up work.

### Stop condition

Decided to land. The headline acceptance criteria split:

- ✓ Genuine-draw count went 12 → 0.
- ✓ Land-only maps did not regress.
- ✓ All 378 prior tests still pass.
- ~ Cap-stalemate cell count unchanged (14/36) but now ALL resolve
  to tie-break winners instead of true 1-1 draws.
- ✗ Pair-win-rate floor regressed on `economist vs turtle` — 25 % →
  0 %. Driven by turtle's static defensive posture on sea maps
  rather than amphibious behaviour, so deferring to round 8 turtle
  retuning rather than blocking on it.

Round 7 closed.


---

## Iteration 8 — defender actually defends (pilot, 10/pair/map, land maps)

**Trigger:** live-site match report — "balanced parked a unit in the corner
and let me sit on his factory." First bug found via the replay/live-play
channel rather than tournaments. Scenario repro + `ai-trace` showed
defender-role units scoring on nothing but positional/futureThreat: the
role's ×3 self-threat multiplier plus a toward-own-HQ objective made every
tile near the (threat-blanketed) home zone score negative, so defenders
drifted to the safest far tile and parked. No scoring term valued attacking
an enemy mid-capture on owned property, for any persona.

**Changes:**
- `roles.ts` defender multipliers: `{futureThreat: 3, capture: 0}` →
  `{damageDealt: 1.5, futureThreat: 0.5, capture: 0}` — defenders accept
  personal risk to hold ground.
- `utility.ts` defender objective: step-toward-own-HQ → step-toward
  `nearestHomeIntruder` (enemy mid-capture on owned tile, by progress;
  else enemy within DEFENDER_PROXIMITY+1 of HQ; HQ as garrison fallback).
- `utility.ts` new raw term: `DEFEND_PROPERTY_BONUS = 4` (up to ×2 as the
  capture bar fills) for ATTACKing an enemy standing on an owned
  capturable. Deliberately unweighted — no persona shrugs at a flip.
- Doctrine regression suite: `tests/ai-defense.test.ts`.

**Results (180 matches, 10/pair/map, duel+crossroads+canyon):**

| persona   | pre-fix WR | post-fix WR | Δ        |
|-----------|-----------|-------------|----------|
| economist | 72.2%     | 77.8%       | +5.6 pp  |
| aggressor | 61.1%     | 38.9%       | −22.2 pp |
| turtle    | 50.0%     | 50.0%       | 0        |
| balanced  | 16.7%     | 33.3%       | +16.6 pp |

**Interpretation:** balanced (the biggest victim of cowardly defense)
doubles its record; aggressor pays because its capturer-rush now meets
defenders that fight back. Both directions are the fix working. Known
NON-regressions (verified present in the pre-fix baseline run): turtle
beats balanced 30/30; crossroads still produces ~121-turn cap games;
economist remains strongest.

**Next-iteration candidates:** retune aggressor against live defenses;
turtle-vs-balanced 100%; crossroads cap-stalemates; symmetric
utility-vs-utility never terminates on duel (found same day via headless
live-site run).

---

## Tooling baseline (pre-iteration-9)

Wave-1 tooling merged (doctrine suite, probes, i8 benchmarks, replay miner,
this runbook). Recorded before any iteration-9 tuning as the regression
yardstick. Suite: 641/642 (the one failure is the documented tier3
wall-clock flake; green solo). Benchmark mirror sanity: balanced vs
balanced-i8 exactly 15-15 (50.0%) over 30 matches — plumbing is faithful.

**Probe-gate matrix (10 seeds/side, duel+crossroads+canyon, bar 70%):**

| persona   | probe-camper      | probe-kiter       | probe-rush |
|-----------|-------------------|-------------------|------------|
| aggressor | 66.7% (20-0-10)   | 73.3% (22-1-7)    | 100%       |
| balanced  | 30.0% (9-0-21) ✗  | 23.3% (7-0-23) ✗  | 96.7%      |
| economist | 13.3% (4-0-26) ✗  | 80.0% (24-0-6)    | 100%       |
| turtle    | 10.0% (3-0-27) ✗  | 20.0% (6-4-20) ✗  | 100%       |

6/12 cells under bar (aggressor-camper 66.7% also ✗), failures almost
entirely DRAWS not losses — the shared weakness is closing out games, not
losing them. Converges with: doctrine suite (8 expected-fails, all tagged
FLIP: WP5 — distraction bug, oscillation, unfinished endgames), miner on
the iteration-8 pilot logs (stalled units in 100% of matches, cap hits in
33%), and the 725-turn utility mirror. The 70% bar stands — aggressor and
economist prove it reachable.

---

## Iteration 9 — anti-stall: games that end (pilot, 10/pair/map, land maps)

**Trigger:** three instruments, one verdict. (a) Symmetric mirrors never
terminated — `utility` vs `utility` on duel ran 725+ turns, and the engine has
no turn cap by design. (b) The iteration-8 pilot hit the 120-turn cap in EVERY
match of three crossroads pairings, and the replay miner flagged stalled units
in 92% of matches, cap hits in 33%. (c) The pre-iteration-9 probe gate put
6/12 cells under the 70% bar almost entirely by DRAW (turtle 3-0-27 vs
probe-camper, balanced 9-0-21) — no persona could force a decision against an
opponent that refuses to engage. The doctrine suite carried 8 `it.fails` tests
tagged `FLIP: WP5` saying the same thing in miniature.

### Diagnosis (traces, not theory)

`--trace=5` on the capped games named the guilty components, and every one of
them is a **currency** problem in the shared scorer — which is why all four
personas AND bare `utility` had it:

- `damageDealt` is measured in `hp × cost/1000`: a tank kill ≈ 700, an
  artillery kill ≈ 570. Every *strategic* term was on a different scale — a
  capture flip was `5 × w.capture ≈ 7.5`, taking the enemy HQ (i.e. winning
  the game) was also 5, and iteration 8's `DEFEND_PROPERTY_BONUS` was 4. The
  scorer was a pure combat maximiser that treated the win condition as a
  rounding error. (Distraction doctrine test: attacking the artillery scored
  647.8, contesting the capturer on our own factory 59.8.)
- `futureThreat` is on the damage scale: −51 for an infantry that steps into
  three enemies' reach, −88 for a recon on crossroads, while standing still
  costs 0. Both armies therefore park exactly outside each other's reach
  envelope. Crossroads mirror at turn 121: 35 units vs 10, no contact, no
  capture, no end.
- The act gate was `score > 0` — an absolute comparison against an
  uncalibrated score. A unit under a blanket threat map has no positive
  candidate, including the one that walks out of the fire, so it took **no
  action at all**, permanently (turtle: −434 to stay, −497 to move, planner
  skipped it). That is the miner's stalled-unit signature.
- The `support` objective points AWAY from the enemy and this engine has **no
  repair mechanic**, so every unit that dropped under 50 hp deserted for good.
  At turn 121 of economist-vs-balanced, twelve damaged economist units were
  scoring +5.4 each to retreat from four enemies they outnumbered 3:1.
- Non-capturers squat on capturable tiles. Turtle drove a TANK onto the
  exposed enemy HQ; economist parked a 3 hp tank on balanced's HQ while its
  own infantry stood two tiles away. Tanks cannot capture, and the squatter
  blocks the only unit that can.
- Units squat on their OWN factory, which silently switches production off
  (`enumerateBuilds` skips occupied factories). In tier3-vs-tier1 on duel BOTH
  sides had done it by turn 40 and banked 100k+ funds against a frozen board.
- Composition: balanced bought TWELVE fighters against an all-ground
  aggressor. `DAMAGE.fighter.tank === 0` and `DAMAGE.tank.fighter === 0` — the
  armies could not touch each other, and neither could capture. No scoring
  change closes out a game the roster is incapable of closing.

### Changes — `src/engine/ai/utility.ts` only

`ai-personas.json` deliberately untouched: the mirror bug is present in bare
`utility`, so the fix had to live in shared scoring.

*Sub-iteration 1 — objectives in damage currency, and stop freezing:*

- `PROPERTY_VALUE = { hq: 2000, factory: 900, city: 450 }` replaces
  `DEFEND_PROPERTY_BONUS = 4`. The defence term (ATTACK an enemy *capturer*
  standing on our capturable) is `value × urgency`, urgency `0.4 → 1.0` with
  the capture bar. Raw, no persona weight, as in iteration 8.
- `HQ_CAPTURE_VALUE = 2000` and `CAPTURE_PRESSURE = { factory: 200, city: 120 }`
  — raw value of CAPTURE progress, pro-rata on the bar, full on the flip.
  Taking the enemy HQ is now scored as winning the game rather than as +5.
- `DRIFT_BONUS = 0.25` / `DRIFT_RETREAT_PENALTY = 1.0` per Manhattan step
  toward / away from the drift target (nearest enemy, else the enemy HQ),
  applied **only to WAIT candidates** — i.e. when the unit has nothing
  productive to do. The asymmetry is what kills oscillation: two attractors
  that both pay in one direction cannot both keep paying once the walk home
  costs 4× the walk out.
- `BLOCKED_CAPTURE_PENALTY = 8` for a non-capturer ending on a capturable that
  one of our own capturers stands beside.
- Act gate: `score > 0` → `score > 0 || score > stayScore`, where `stayScore`
  is the do-nothing candidate (stay put + WAIT). "Do nothing" is a candidate;
  the question is whether the best option beats *it*, not zero.
- Late-game pressure ramp — pure functions of `state.turn`, flat until turn 40,
  fully wound at turn 90 (half-turns, so ≈ rounds 20–45): `pressureRamp`
  1 → 1.5 on damageDealt and objective, `counterRiskRamp` 1 → 0.5,
  `futureThreatRamp` 1 → 0. Speculative caution expires; *measured* counter
  damage only halves. Bounding it at 1.5× (as originally scoped) was useless —
  a −88 wall against a +3 capture is not a 1.5× problem.

*Sub-iteration 2 — the two stalls that survived:*

- The `support` objective — the only one pointing backwards — is scaled by
  `futureThreatRamp` instead of `pressureRamp`, so the retreat mandate expires
  with the rest of the caution. Without this the ramp made the endgame *worse*
  by amplifying the deserters.
- `BLOCKED_HQ_PENALTY = 100`, unconditional for a non-capturer ending on the
  enemy HQ (no adjacent-capturer requirement — the capturer may be three tiles
  away and still coming). Loses to any real attack from that tile (300+),
  beats every positional reason to squat. Alone it took
  economist-vs-balanced/crossroads from 10/10 cap-outs to 0/10, 121 → 45 turns.

*Sub-iteration 3 — production and composition (build phase):*

- **Capturer crisis:** if we own zero capture-capable units and capturables
  remain, build infantry — overriding `preferred`, `avoid`, the infantry-floor
  logic, and (by exactly one unit) `TIER3_UNIT_CAP`. Aggressor held seven
  tanks and zero infantry for the last sixty turns of a capped game.
- **Useful-build filter:** skip a type that can neither capture nor damage any
  enemy unit type currently on the board, unless nothing else is affordable
  (two fallback passes preserve the old spend-anyway behaviour).
- `OWN_FACTORY_SQUAT_PENALTY = 5` for ending a move on our own factory while
  we can afford to build.

New `tests/ai-antistall.test.ts`: one full `utility`-mirror game on duel
(maxTurns 600, asserts a RAW winner, ~2s) plus purity/monotonicity/bounds
pins on the three ramp functions.

### Results — standard pilot, 180 matches, duel+crossroads+canyon

PRE was re-run from the iteration-8 tree and reproduces its post table
exactly (economist 77.8 / turtle 50.0 / aggressor 38.9 / balanced 33.3),
confirming the field was unchanged since iteration 8.

| persona   | pre WR | post WR | Δ        |
|-----------|--------|---------|----------|
| economist | 77.8%  | 94.4%   | +16.6 pp |
| balanced  | 33.3%  | 50.0%   | +16.7 pp |
| aggressor | 38.9%  | 27.8%   | −11.1 pp |
| turtle    | 50.0%  | 27.8%   | −22.2 pp |

Pairwise (row beats col), pre → post:

| row \ col | aggressor  | turtle      | economist | balanced   |
|-----------|------------|-------------|-----------|------------|
| aggressor | —          | 67% → 50%   | 33% → 17% | 17% → 17%  |
| turtle    | 33% → 50%  | —           | 17% → 0%  | 100% → 33% |
| economist | 67% → 83%  | 83% → 100%  | —         | 83% → 100% |
| balanced  | 83% → 83%  | 0% → 67%    | 17% → 0%  | —          |

Degeneracy (`mine-replays --dir logs/rr-iter9-{pre,post}`, 180 files each):

| flag                | pre           | post          |
|---------------------|---------------|---------------|
| turnCapHit          | 60 (33.3%)    | 10 (5.6%)     |
| stalledUnit         | 2600 (91.7%)  | 665 (44.4%)   |
| heldLeadNoWin       | 45 (25.0%)    | 20 (11.1%)    |
| uncontestedCapture  | 115 (41.7%)   | 125 (50.0%)   |

**All-cap cells: 3 → 0.** Pre, `aggressor vs turtle`, `aggressor vs balanced`
and `turtle vs balanced` on crossroads all averaged 121.0 turns (10/10
cap-outs). Post, the slowest cell is `economist vs balanced` crossroads at
117.5 and the ten remaining cap-outs are split 5/5 across two cells. Raw
winner-null rate 5.6%, under the 10% bar.

### Mirror termination (`--max-turns 1000`, RAW winner)

| AI       | map        | seeds | turns | winner |
|----------|------------|-------|-------|--------|
| utility  | duel       | 1–5   | 68    | p0     |
| utility  | crossroads | 1–5   | 55    | p0     |
| balanced | duel       | 1–3   | 70    | p1     |
| turtle   | duel       | 1–3   | 29    | p0     |

16/16 terminate with a board result (HQ capture or rout) in well under 300
turns; pre-iteration-9 every one of them ran to 1000 and stopped only because
the harness said so. Seeds are identical within a row because the utility AI
consumes no RNG — the mirror is one deterministic game per (AI, map).

### Probe gate (10 matches/cell/map, 3 land maps, bar 70%)

| persona   | probe-camper       | probe-kiter       | probe-rush        |
|-----------|--------------------|-------------------|-------------------|
| aggressor | 66.7% → **100%**   | 73.3% → **100%**  | 100% → 100%       |
| balanced  | 30.0% → **90.0%**  | 23.3% → **100%**  | 96.7% → **100%**  |
| economist | 13.3% → **86.7%**  | 80.0% → **100%**  | 100% → 100%       |
| turtle    | 10.0% → **70.0%**  | 20.0% → **100%**  | 100% → 100%       |

PASS — 12/12 cells clear the bar (6/12 failed pre), no cell regresses, and the
draws are gone: every kiter/rush cell is now 30-0-0. The bar formally binds in
WP7; it is already green.

### Sea sanity (armada+island_hop, 4/pair/map, pre and post both re-run)

No pairing that was above 0% dropped to 0%; `turtle vs economist` came off the
floor (0% → 50%). Every sea cell still runs to the 121-turn cap in both runs —
unchanged, and the strategic-design issue iteration 7 already recorded.

### Suite

`npx vitest run`: 646/646 green across 65 files (was 641/642 + 8 known-red
doctrine cases). All 8 `FLIP: WP5` doctrine tests flipped to `it` and pass —
the distraction family (×4), oscillation (×3, including turtle, which did NOT
need a persona lever) and turtle's tank-on-the-HQ endgame. Determinism suite
green (all three ramps are pure functions of `state.turn`).
`tests/ai-tier3-vs-tier1.test.ts` solo: both acceptances green **including**
the 200 ms/turn budget — the factory-squat fix removed the frozen-board
endgames that had pushed the max turn to 386 ms mid-iteration. `npm run lint`
clean. Whole-suite wall clock dropped 151s → 58s, because games now end.

### Known regressions and what is left

- **Two new pairwise-floor violations:** `turtle vs economist` 17% → 0% and
  `balanced vs economist` 17% → 0%. Economist gains most from pricing capture
  in damage currency (`capture 1.8`, capturer role ×4.5) and is now at 94.4%
  overall. This is a **persona-weight** problem, not a shared-scoring one, and
  WP5 is forbidden from touching `ai-personas.json` — it lands in WP6/WP7's
  lap, and the escalation is deliberate: the old floors were held up by games
  that never finished. The previously-worst floor, `balanced vs turtle` 0/30,
  is fixed (0% → 67%).
- `uncontestedCapture` is the one miner flag that did not improve (41.7% →
  50.0%). With games decided ~60 turns earlier there is simply more capturing
  per match; the flag counts events, not rates. Worth a proper look in WP7.
- Sea maps remain 100% cap-outs. Nothing here targeted them, and the pre/post
  comparison shows no harm.
- Budget: 3 sub-iterations, as scoped.

**Campaign impact.** `ai-personas.json` was not touched, so no persona was
retuned — but every persona shares this scorer, so mission difficulty moved
anyway. New land-map ordering: economist 94.4% > balanced 50.0% > aggressor
27.8% = turtle 27.8%. The intended ramp (turtle < balanced < economist <
aggressor) still does NOT hold: mission 4 (aggressor) is now the joint-easiest
opponent and mission 3 (economist) is close to unbeatable. Aggressor's
capture-light, damage-heavy weights are the persona that gains least from
win-condition pricing, and turtle's terrain-anchored defence no longer earns
free half-points from unfinished games. Restoring the ramp is WP7's job and it
now has to move aggressor ~65 pp against economist; WP6 should also note that
turtle-vs-balanced flipped direction (turtle 100% → 33%).

---

## Iteration 10 — the two floors were broken opponents, not a broken economist (pilot, 10/pair/map, land maps)

**Trigger:** escalated from iteration 9. Pricing objectives in damage currency
put economist at 94.4% and opened two hard floors — `turtle vs economist`
17% → 0% and `balanced vs economist` 17% → 0% — while turtle collapsed to
27.8%, joint-last with aggressor. Iteration 9 was forbidden from touching
`ai-personas.json` and handed the persona-weight half of its own result here.

### Diagnosis (traces, not theory)

The leading hypothesis was that economist's `capture: 1.8` multiplies
iteration 9's new absolute capture pricing. **That is false, and worth writing
down**: `winPush` (`HQ_CAPTURE_VALUE`, `CAPTURE_PRESSURE`) is added *raw* in
`scoreAction` — no `w.capture`, no role multiplier — exactly like `defense`.
The only weighted capture term is `captureProgressScore`, which returns 2 or 5,
so economist's capture weight buys it at most ~13 points of the 120–200 a city
tick pays everyone. There was no double-dip. **Economist's config was not
touched in this iteration**; both floors were failures of the *losing* side.

**(a) turtle — a persona that re-opened the iteration-8 bug from its own
`roleOverrides`.** `--trace=5` on `turtle-vs-economist/canyon` (a rout at turn
50, `logs/rr-iter10-pre`): from half-turn 25 onward *every* turtle unit is in
the `defender` role — 70 of 119 unit-decisions in the match, against 6 of 173
for economist. Economist keeps a unit inside turtle's home zone, `hqUnderThreat`
never clears, and `DEFENDER_PROXIMITY` covers turtle's whole half of the board.

That would be survivable, except turtle's persona carried
`roleOverrides.defender.futureThreat: 3.0` — the **pre-iteration-8 multiplier**.
Iteration 8 fixed the cowardly defender in the shared table (`roles.ts`
defender `futureThreat` ×3 → ×0.5); turtle's override quietly reinstated it for
turtle alone. Effective weight `0.7 × 3.0 = 2.1` against the field's
`0.5 × 0.5 = 0.25` — **8.4×** — on a persona whose army is cost-7 tanks and
cost-8 aatanks, and `futureThreatFromMap` scales with the acting unit's cost.

Half-turn 35, turtle tank `u15`, with the whole army frozen behind it:

```
ATTACK  dest 5,1  score -273.69  {damageDealt 85.5, counterRisk 0, futureThreat -360.15}
WAIT    dest 0,2  score    0.88  {positional 0.88}                        ← chosen
```

`counterRisk 0` — the trade costs nothing measurable. It declined anyway, and
so did every other turtle unit, on nothing but speculative threat. Turtle's
property count sat at **3 for all 50 turns** (the defender role also carries
`capture: 0`) while economist went 2 → 5 properties and 1 → 12 units.

**(b) balanced — 31% of its build budget on a unit that does 10 damage.**
Build census over the pre-pilot's 60 balanced-vs-economist matches:

| persona   | tank | recon | infantry |
|-----------|------|-------|----------|
| economist | 505  | 0     | 325      |
| balanced  | 380  | 255   | 245      |

`enumerateBuilds` walks `preferred` and takes the first *affordable* entry, so
balanced's `[cruiser, fighter, tank, recon, aatank, artillery, infantry]`
resolved on land to **tank ≥7000 / recon 4000–6999 / infantry below**. Against
an armour opponent that is a money fire: `DAMAGE.recon.tank = 10`,
`DAMAGE.tank.recon = 85`. Economist's list ranks infantry above recon and so
never buys one. Balanced also never reached `artillery` (6000 — the only unit
in the field that answers massed tanks: 70 damage at range 2–3, no counter)
because recon sat in front of it.

### Changes — `src/data/ai-personas.json` only

`utility.ts` and `roles.ts` untouched: both mechanisms are persona
configuration, and iteration 9's shared-scoring gates are load-bearing.

*Sub-iteration 1 — turtle `roleOverrides.defender.futureThreat` `3.0 → 0.5`.*
Adopts the shared post-iteration-8 default. `positional: 1.6` and `capture: 0`
left alone; this is the one key that contradicted a closed bug.

*Sub-iteration 2 — balanced `buildPolicy.preferred`, `recon` removed:*
`[cruiser, fighter, tank, recon, aatank, artillery, infantry]` →
`[cruiser, fighter, tank, artillery, aatank, infantry]`. Land bands become
tank ≥7000 / **artillery 6000–6999** / infantry below.

*Sub-iteration 3 — balanced `buildPolicy.infantryFloor` `(default 2) → 4`.*
Calibration of the same lever, not a new mechanism: sub-iteration 2 overshot
(balanced 77.8%, above economist) and with recon gone balanced's opening ran
straight to armour. The floor restores an infantry opening — infantry is now
its most-built unit (1180 infantry / 1125 tank / 220 artillery, zero recon).

### Doctrine test (red before the fix)

`tests/ai-doctrine.test.ts` §6, "a pinned defender still fights": a 40 hp enemy
infantry inside p1's home zone with two enemy tanks standing off behind it. The
kill is *free* — the target dies, so there is no counter — and nothing stands
on p1 property, so the property-denial bonus never fires. The only reason to
decline is speculative threat. Two assertions: it swings, and it does not back
away from an intruder it can kill.

| persona   | damageDealt | counterRisk | futureThreat | total    | decision                 |
|-----------|-------------|-------------|--------------|----------|--------------------------|
| balanced  | 60          | 0           | −42.9        | +19.2    | ATTACK                   |
| turtle    | 60          | 0           | **−360.2**   | **−297** | WAIT in the board corner |

Committed red for turtle alone (`FLIP: WP6`), green for the other three — the
scenario is a persona discriminator, not a scoring bug. Green for all four
after sub-iteration 1. **A persona can re-open a closed bug from its own
`roleOverrides` and no tournament will say so out loud**: turtle's 50% in
iterations 8–9 hid this completely, and it only surfaced once iteration 9 made
games finish.

### Results — standard pilot, 180 matches, duel+crossroads+canyon

PRE reproduces iteration 9's post table exactly (economist 94.4 / balanced 50.0
/ aggressor 27.8 / turtle 27.8), confirming an unchanged field.

| persona   | pre WR | post WR | Δ        |
|-----------|--------|---------|----------|
| economist | 94.4%  | 72.2%   | −22.2 pp |
| balanced  | 50.0%  | 72.2%   | +22.2 pp |
| turtle    | 27.8%  | 38.9%   | +11.1 pp |
| aggressor | 27.8%  | 16.7%   | −11.1 pp |

Per sub-iteration:

| persona   | pre  | s1 (turtle defender) | s2 (recon out) | s3 = post (floor 4) |
|-----------|------|----------------------|----------------|---------------------|
| economist | 94.4 | 88.9                 | 66.7           | 72.2                |
| balanced  | 50.0 | 44.4                 | 77.8           | 72.2                |
| turtle    | 27.8 | **50.0**             | 38.9           | 38.9                |
| aggressor | 27.8 | 16.7                 | 16.7           | 16.7                |

Pairwise (row beats col), pre → post:

| row \ col | aggressor   | turtle       | economist    | balanced    |
|-----------|-------------|--------------|--------------|-------------|
| aggressor | —           | 50% → 17%    | 17% → 17%    | 17% → 17%   |
| turtle    | 50% → 83%   | —            | **0% → 17%** | 33% → 17%   |
| economist | 83% → 83%   | 100% → 83%   | —            | 100% → 50%  |
| balanced  | 83% → 83%   | 67% → 83%    | **0% → 50%** | —           |

**Both 0% floors are gone, and for the first time in this project every one of
the twelve pairwise cells is ≥10% in both directions.** The minimum is 17%,
which on this harness is exactly one of the six deterministic map×side games
that make up a pairing — the utility AI consumes no RNG, so 30 matches per
pairing are 6 distinct games played 5× each, and win rates are quantised to
1/6 per pairing and 1/18 overall. Every table here should be read at that
resolution.

Turn-cap behaviour is unchanged and the gate holds: **zero all-cap cells** pre
and post, 10/180 cap hits (5.6%) in both runs, raw-winner-null 5.6% (bar 10%).
The capping cells moved (`economist-vs-balanced` and `turtle-vs-economist` on
crossroads → `turtle-vs-balanced` crossroads and `turtle-vs-economist` canyon)
but none is all-cap. Side balance drifted p0 58.3% → 66.7%, tripping the
round-robin's own >20 pp warning; with 36 deterministic games that is a
2-game move, not a new asymmetry, but it is worth a look if a later iteration
wants finer resolution.

### Probe gate (10 matches/cell/map, 3 land maps, bar 70%)

| persona   | probe-camper | probe-kiter | probe-rush | vs iteration 9 |
|-----------|--------------|-------------|------------|----------------|
| aggressor | 100%         | 100%        | 100%       | unchanged      |
| balanced  | 90.0%        | 100%        | 100%       | unchanged      |
| economist | 86.7%        | 100%        | 100%       | unchanged      |
| turtle    | 70.0%        | 100%        | 100%       | unchanged      |

PASS — 12/12 clear the bar and **no cell moved by a single match** from
iteration 9's table. Turtle sits exactly on the 70% bar (21-0-9 vs
probe-camper, the residue being draws, not losses); its defender fix did not
help there, because probe-camper never threatens the HQ and so never triggers
the defender role at all. That cell is the field's thinnest margin and any
future turtle change should re-run this gate first.

### Cross-generation (vs the frozen i8 field, 6/pair/map, 270 matches)

| persona      | overall | vs its own -i8 self |
|--------------|---------|---------------------|
| economist    | 76.7%   | 50.0% (9-9)         |
| balanced     | 73.3%   | **100%** (18-0)     |
| turtle       | 30.0%   | 50.0% (9-9)         |
| economist-i8 | 76.7%   | —                   |
| turtle-i8    | 26.7%   | —                   |
| balanced-i8  | 16.7%   | —                   |

Full matrix (row beats col, over 18 matches per cell):

| row \ col    | economist | turtle | balanced | economist-i8 | turtle-i8 | balanced-i8 |
|--------------|-----------|--------|----------|--------------|-----------|-------------|
| economist    | —         | 83%    | 50%      | 50%          | 100%      | 100%        |
| turtle       | 17%       | —      | 17%      | 17%          | 50%       | 50%         |
| balanced     | 50%       | 83%    | —        | 50%          | 83%       | 100%        |
| economist-i8 | 50%       | 83%    | 50%      | —            | 100%      | 100%        |
| turtle-i8    | 0%        | 50%    | 17%      | 0%           | —         | 33%         |
| balanced-i8  | 0%        | 50%    | 0%       | 0%           | 67%       | —           |

PASS — nobody loses to its own frozen self worse than 40/60. Two readings
worth keeping:

- `economist vs economist-i8` is **exactly 50.0%**, and so is
  `economist-i8`'s whole row against economist's. The configs are byte-
  identical, so this is a true mirror — an independent confirmation that
  iteration 10 did not touch economist, and a live calibration check on the
  benchmark plumbing (cf. the tooling baseline's balanced-vs-balanced-i8 15-15).
- `balanced vs balanced-i8` is **18-0**. The recon removal is not a
  redistribution of the field's win rates, it is an absolute strength gain
  against a fixed opponent — the strongest single-persona cross-gen result
  recorded so far.
- `turtle vs turtle-i8` is 9-9. The defender fix is worth +11 pp against the
  *field* but is head-to-head neutral against turtle's own frozen self, which
  is what you would expect from a change that stops a shared failure mode
  rather than adding an edge: in the mirror both sides freeze or neither does.

### Mirror termination (`--map duel --seed 1 --max-turns 1000`, RAW winner)

| AI        | turns | winner | iteration 9 |
|-----------|-------|--------|-------------|
| economist | 54    | p1     | (not run)   |
| turtle    | 77    | p0     | 29, p0      |
| balanced  | 44    | p1     | 70, p1      |

All three end on a board result far inside the 300-turn bar. Turtle's mirror
lengthened 29 → 77 turns, which is the fix showing up: both sides now contest
instead of one army standing still while the other walks through it.

### Degeneracy (`mine-replays --dir logs/rr-iter10-{pre,post}`, 180 files each)

| flag               | pre           | post          |
|--------------------|---------------|---------------|
| turnCapHit         | 10 (5.6%)     | 10 (5.6%)     |
| heldLeadNoWin      | 20 (11.1%)    | 20 (11.1%)    |
| uncontestedCapture | 90 (50.0%)    | 70 (38.9%)    |
| stalledUnit        | 80 (44.4%)    | **120 (66.7%)** |

`uncontestedCapture` finally moves (50.0% → 38.9% of files) — the flag
iteration 9 could not shift. `stalledUnit` regresses on file coverage while
total hits fall slightly (665 → 645): the same amount of standing around,
spread thinner across more matches. Balanced's infantry floor is the obvious
suspect (more cheap bodies, more of them with nothing to do on a given turn)
and it is worth a trace in WP7, but it is not a gate and the turn-cap and
held-lead flags — the ones that measure whether games *end* — are unmoved.

### Suite

`npx vitest run`: 654/654 green across 65 files. Includes the two new doctrine
positions (§6, "a pinned defender still fights"), both committed red for
turtle and flipped by sub-iteration 1.

`tests/ai-benchmarks.test.ts` needed one edit and it is the sanctioned one:
the snapshot-fidelity assertion (`frozen.buildPolicy === live.buildPolicy`)
fails by design when a persona is retuned, and its own comment says the fix is
to drop the expectation for the changed persona, never to re-freeze i8. Turtle
and balanced are now listed in `RETUNED_SINCE_I8`; aggressor and economist
still assert byte-identity. **This is the first persona retune since the i8
freeze, so it is the first time that assertion has ever fired.**

`tests/ai-tier3-vs-tier1.test.ts` reproduced the documented wall-clock flake
(209.5 ms against the 200 ms budget) on the first solo re-run and passed on the
second (and the win-rate acceptance never failed). It is provably unrelated to
this iteration: `makeAI('tier3')` builds `utilityAI` with default weights and
the canonical `ROLE_MULTIPLIERS` and never reads `ai-personas.json`, so no
persona change can alter what that test simulates. `fog-acceptance.test.ts`
flaked once in the same way and passed on re-run. `npm run lint` clean.

### Known regressions and what is left

- **Aggressor 27.8% → 16.7%**, and `aggressor vs turtle` 50% → 17%. Turtle no
  longer stands still while aggressor's capturers walk past it, so aggressor
  loses the matchup it was winning by default. Not tuned here (aggressor is
  WP7's, by scope) and the direction is the fix working, but WP7 now starts
  from a lower floor than iteration 9 left it.
- **`turtle vs balanced` 33% → 17%.** Turtle's own gains landed elsewhere;
  balanced's artillery is a genuinely bad matchup for turtle's armour. Still
  above the 10% floor, in both directions, but it is the thinnest of the four
  cells that moved against turtle.
- **The balanced lever family is quantised.** `recon` cannot be re-introduced
  at *any* priority without balanced collapsing back to 0% vs economist
  (measured: recon after `artillery`/`aatank` → 0/30), and removing `artillery`
  instead drops `turtle vs balanced` to 0% (measured: 0/30). `infantryFloor` is
  equally sharp: 4 → 50% vs economist, 5 → 17%, 6 → 17% with turtle-vs-balanced
  flipping to 83%. There is no setting between "balanced beats economist 50%"
  and "balanced beats economist 17%", which is why the ramp lands where it does
  (see Campaign impact).
- Sea maps were not re-run; nothing here targets them and both changed levers
  are land-band build order and a defender multiplier.
- Budget: 3 sub-iterations, as scoped, plus four 2–3-persona probe runs used to
  choose the sub-iteration-3 calibration before spending the pilot on it.

**Campaign impact.** Land-map ordering after this change: **economist 72.2% =
balanced 72.2% > turtle 38.9% > aggressor 16.7%** (pre: economist 94.4 >
balanced 50.0 > aggressor 27.8 = turtle 27.8). Against the intended ramp
**turtle < balanced < economist < aggressor**:

- `turtle < balanced` — **HOLDS** (38.9% < 72.2%). It did not hold in any
  meaningful sense before: turtle and balanced were 27.8 and 50.0 with turtle
  beating balanced in a third of games and losing 0/30 to economist.
- `balanced < economist` — **does NOT hold: an exact tie at 72.2%.** This is
  an improvement on iteration 9 (where economist led balanced by 44 pp the
  wrong way round for mission difficulty) and on sub-iteration 2 (where
  balanced led economist outright), but it is not the ordering. The arithmetic
  says it is not reachable by moving the balanced-economist pairing alone:
  the two personas trade cells 1:1, so `economist ≤ 75%` forces balanced to
  win ≥3 of their 6 games, and with balanced also taking 5/6 from both
  aggressor and turtle that puts it level. Separating them needs balanced to
  drop a cell to *turtle or aggressor*, i.e. a turtle or aggressor lever —
  WP7 territory.
- `economist < aggressor` — **does NOT hold** (72.2% vs 16.7%). WP7's job, and
  it is now a ~56 pp climb rather than iteration 9's ~66 pp.

Mission difficulty has shifted: **mission 1 (turtle) is harder** than it was
(27.8 → 38.9), **mission 2 (balanced) is much harder** (50.0 → 72.2),
**mission 3 (economist) is easier** (94.4 → 72.2), and **mission 4
(aggressor) is easier again** (27.8 → 16.7) and remains the easiest opponent
in the game while being pinned as the final mission. Missions 2 and 3 are now
indistinguishable in difficulty.

---

## Iteration 11 — the tank-push persona was buying scouts (pilot, 10/pair/map, land maps)

**Trigger:** the last scheduled tuning package, escalated from iterations 9 and
10. Aggressor sat at **16.7%** — last in the field, losing exactly 5 of every 6
games to all three opponents — while the campaign pins it as the FINAL mission
on the assumption that it is the HARDEST opponent. Iteration 10 also left
economist and balanced in an exact 72.2% tie and recorded that separating them
was unreachable from either persona's own lever family.

### Diagnosis (traces, not theory)

Four hypotheses came in with the brief. Two die on inspection, one dies on
measurement, and the mechanism that actually mattered was on none of the lists.

**"`capture 0.9` is mis-tuned against `damageDealt 1.2`" — FALSE, structurally,
and it is the same trap iteration 10 fell into for economist.** `w.capture`
multiplies only `captureProgressScore`, which returns 2 or 5. Every term that
prices territory — `HQ_CAPTURE_VALUE` 2000, `CAPTURE_PRESSURE` 200/120,
`PROPERTY_VALUE` up to 2000 — is added **raw** in `scoreAction`, with no persona
weight and no role multiplier. Aggressor's capture weight is worth at most ~13
points against city ticks that pay everyone 60–120. It cannot be the lever in
either direction; **`capture` was not touched.**

**"`artillery` in `buildPolicy.avoid` removes its siege answer" — FALSE,
measured** (see the rejected-lever table below). Giving aggressor artillery in
the 6000 band costs it 17 pp and triples its cap-outs.

**"`counterRisk 0.7` is too low and feeds units" — TRUE, but worth zero net
games on its own.** Aggressor really did end games with an empty board (0 units
in the traced duel loss), and raising the weight is the right correction, but it
buys one game from balanced and gives one back to turtle. Its actual value was
elsewhere: it restored the floor sub-iteration 1 broke, and its exact value
turned out to decide whether the aggressor mirror terminates at all.

**"`roleOverrides.frontline {damageDealt 1.5, counterRisk 0.8}` promotes suicide
trades" — NOT SUPPORTED, and not needed.** The override is a *multiplier* on the
base weight, so raising the base from 0.7 to 0.95 lifts the frontline role's
effective counterRisk from 0.56 to 0.76 without touching the override. Traced
frontline attacks were not suicidal in the first place (a chosen tank ATTACK
scored `damageDealt 365.4` against `counterRisk −82.3`, i.e. 203 raw damage dealt
for 147 raw taken — a trade balanced would also take). **`roleOverrides` was not
touched.**

**The mechanism: the tank-push persona was spending a third of its money on
recon.** `enumerateBuilds` walks `preferred` and takes the first AFFORDABLE
entry, so a persona's list is a set of PRICE BANDS. Aggressor's was
`[bomber 14000, cruiser 11000, tank 7000, fighter 12000, recon 4000,
infantry 1000]` — on a land map that resolves to **tank ≥7000 / recon
4000–6999 / infantry below**, and the treasury sits in that middle band most
turns. `DAMAGE.recon.tank = 10`; `DAMAGE.tank.recon = 85`. This is precisely the
money fire iteration 10 removed from balanced, still live in aggressor, and it
directly contradicts the persona's own description.

Build census over the iteration-10 post pilot (90 matches per persona):

| persona   | infantry | recon | tank | bomber |
|-----------|----------|-------|------|--------|
| aggressor | 11.2     | **9.8** | 5.7  | 0.9    |
| balanced  | 13.1     | 0     | 12.5 | 0      |
| economist | 16.6     | 0     | 16.5 | 0      |

On **duel**, where aggressor lost all six deterministic games, it built **8.0
recon against 1.3 tanks per match**. The single game `--map duel --seed 1 --p0
aggressor --p1 economist` ends at turn 38 with aggressor on **zero units**, two
properties and 11000 unspent: it had bought 10 infantry, **7 recon** and one
tank against economist's 11 infantry and 6 tanks. 39 of its 81 unit-decisions in
that game were recon decisions.

### Doctrine test (red before the fix)

`tests/ai-doctrine.test.ts` §7, "buys an army that can fight the one on the
board": an all-tank enemy, our capturer requirement already met (no
capturer-crisis override) and six units on the board (no infantry floor), with
the treasury parked at 4000 and at 6000 — below a tank. The assertion is that
whatever is bought either captures or does ≥25 damage to a tank.

| funds | aggressor  | turtle   | economist | balanced  |
|-------|------------|----------|-----------|-----------|
| 4000  | **recon**  | infantry | infantry  | infantry  |
| 6000  | **recon**  | infantry | infantry  | artillery |
| 7000  | tank       | tank     | tank      | tank      |

Committed red for aggressor alone (`FLIP: WP7`), green for the other three —
a persona discriminator, not a scoring bug. Green for all four after
sub-iteration 1.

### Changes — `src/data/ai-personas.json` only (aggressor only)

`utility.ts` and `roles.ts` untouched; economist and balanced and turtle
untouched. Every change is inside the persona that was being retuned.

*Sub-iteration 1 — `buildPolicy.preferred`, `recon` removed:*
`[bomber, cruiser, tank, fighter, recon, infantry]` →
`[bomber, cruiser, tank, fighter, infantry]`. The land bands become **tank
≥7000 / infantry below**, which is what "tank push with HQ-pressing infantry
pushers" was supposed to mean all along.

*Sub-iteration 2 — `weights.counterRisk` `0.7 → 0.95`.* Aggressor was the only
persona under 0.8 and it ends games with an empty board. This is *measured*
counter-damage, not speculative threat (`futureThreat` stays at 0.3 — the
persona still walks into danger, it just stops taking trades it loses). Landed
at 1.0, then recalibrated to 0.95 by the mirror gate — see below.

*Sub-iteration 3 — `buildPolicy.infantryFloor` `3 → 4`.* Calibration of the
same build lever as sub-iteration 1: with recon gone, aggressor's opening ran
straight to armour and its capture rush went with it. This is the lever that
separates economist from balanced, exactly as iteration 10 predicted it would
have to be a turtle-or-aggressor lever: it takes one more game off balanced
without taking one off economist.

### Rejected levers (measured, not argued)

Screens are full-field, 3 maps, `--matches 2`. **`--matches 2` is the complete
deterministic set** — the utility AI consumes no RNG, so a pairing is 6 games,
and a 2-match screen reproduces the 10-match table exactly (verified against the
pre-pilot: same overall rates, same pairwise cells, at 1/5 the wall clock — the
screening harness of this iteration, and worth reusing).

| lever (on top of sub-iteration 1)          | aggressor | field                          | verdict |
|--------------------------------------------|-----------|--------------------------------|---------|
| `artillery` into the 6000 band, out of `avoid` | 44.4%  | econ 66.7 > bal 61.1 > turtle 27.8 | rejected — −17 pp, rawNull 5.6% → 16.7%, aggressor-vs-balanced cells at 108/119/118 turns |
| `counterRisk 1.2`                          | vs balanced 2-4 | —                        | rejected — overshoots |
| `counterRisk 0.9`                          | vs balanced 3-3 | —                        | rejected — crossroads cell to 121 turns (cap) |
| `counterRisk 0.95` (adopted)               | vs balanced 3-3 at floor 3, 5-1 at floor 4 | — | adopted |

### Results — standard pilot, 180 matches, duel+crossroads+canyon

PRE reproduces iteration 10's post table exactly (economist 72.2 / balanced 72.2
/ turtle 38.9 / aggressor 16.7, and every pairwise cell), confirming an
unchanged field.

| persona   | pre WR | post WR | Δ        |
|-----------|--------|---------|----------|
| aggressor | 16.7%  | 77.8%   | **+61.1 pp** |
| economist | 72.2%  | 55.6%   | −16.6 pp |
| balanced  | 72.2%  | 50.0%   | −22.2 pp |
| turtle    | 38.9%  | 16.7%   | −22.2 pp |

Per sub-iteration:

| persona   | pre  | s1 (recon out) | s2 (counterRisk) | s3 = post (floor 4) |
|-----------|------|----------------|------------------|---------------------|
| aggressor | 16.7 | 61.1           | 61.1             | **77.8**            |
| economist | 72.2 | 61.1           | 61.1             | 55.6                |
| balanced  | 72.2 | 66.7           | 61.1             | 50.0                |
| turtle    | 38.9 | **11.1**       | 16.7             | 16.7                |

(The s2 column was measured at `counterRisk 1.0`, the value the mirror gate
later rejected. `0.95` and `1.00` produce identical field tables — verified at
floor 4, where both give aggressor 77.8 / economist 55.6 / balanced 50.0 /
turtle 16.7 and the same twelve cells. Only the self-mirror distinguishes them.)

Pairwise (row beats col), pre → post:

| row \ col | aggressor   | turtle      | economist   | balanced    |
|-----------|-------------|-------------|-------------|-------------|
| aggressor | —           | 17% → 83%   | 17% → 67%   | 17% → 83%   |
| turtle    | 83% → 17%   | —           | 17% → 17%   | 17% → 17%   |
| economist | 83% → 33%   | 83% → 83%   | —           | 50% → 50%   |
| balanced  | 83% → 17%   | 83% → 83%   | 50% → 50%   | —           |

**Ordering achieved: aggressor 77.8% > economist 55.6% > balanced 50.0% >
turtle 16.7%**, and every one of the twelve pairwise cells is ≥17% in both
directions (the 1/6 quantum — one of the six deterministic games per pairing).
Zero all-cap cells, 10/180 cap hits (5.6%), raw-winner-null 5.6%, unchanged from
the pre run. Side balance p0 115/65, in line with iteration 10's 120/60.

Each sub-iteration is legible in that table:

- **s1** is the whole recon result: +44.4 pp in one line of JSON. It also broke a
  floor — `turtle vs aggressor` went to **0/6** — which is what "aggressor is
  genuinely stronger now" looks like before it is bounded.
- **s2** is worth zero net games and is not therefore worthless: it trades the
  turtle game back (restoring the floor at 17%) for a game off balanced. Raising
  the price of a bad trade makes aggressor lose *fewer* games to the persona that
  punishes bad trades, and win *fewer* by attrition against the persona that
  cannot punish anything.
- **s3** is the ordering. Floor 4 buys the fourth capturer that turns a tank
  push into a capture rush; it takes one more game from balanced (3-3 → 5-1)
  while leaving `aggressor vs economist` at 4-2, which is exactly the asymmetric
  cell iteration 10 said would be needed to break the economist/balanced tie.

Build census after the change (aggressor, per match): **16.7 infantry, 10.2
tanks, 1.4 bombers, zero recon** — against 11.2 / 5.7 / 0.9 / **9.8** before.
The persona now builds what its description always claimed.

### Wide land pilot — 240 matches, duel+crossroads+canyon+**highlands**

The final-validation gate. Highlands has never been in a pilot before, so every
number on that map is newly measured, not a delta.

| persona   | wide WR | 3-map WR |
|-----------|---------|----------|
| aggressor | 75.0%   | 77.8%    |
| economist | 58.3%   | 55.6%    |
| balanced  | 50.0%   | 50.0%    |
| turtle    | 16.7%   | 16.7%    |

| row \ col | aggressor | turtle | economist | balanced |
|-----------|-----------|--------|-----------|----------|
| aggressor | —         | 75%    | 63%       | 88%      |
| turtle    | 25%       | —      | 13%       | 13%      |
| economist | 38%       | 88%    | —         | 50%      |
| balanced  | 13%       | 88%    | 50%       | —        |

**PASS on ordering and on floors** — the same ordering as the 3-map pilot, and
all twelve cells ≥13% both ways (the quantum here is 1/8 = 12.5%).

**FAIL on "zero all-cap cells", and neither all-cap cell contains an aggressor
game.** `turtle vs balanced|highlands` and `economist vs balanced|highlands` are
both 10/10 turn-cap at 121.0 turns — pairings among the three personas this
iteration did not touch, on the one map no previous pilot measured. Of the 35
raw-winner-null games, 30 are in those two cells plus the two half-capped cells
iteration 10 already recorded (`turtle vs economist|canyon`,
`turtle vs balanced|crossroads`); the remaining 5 are
`aggressor vs turtle|highlands`, a cell that splits 5-5 at 100.0 turns and is
therefore not all-cap. The 3-map standard pilot on the same config has **zero**
all-cap cells and a 5.6% null rate, inside iteration 9's 10% bar; the wide run
is 14.6% with the entire excess on highlands. **Flagged for a future iteration:
it is a balanced/turtle-on-highlands problem and is not reachable from
aggressor's config.**

### The mirror gate caught a knife-edge, and it is worth writing down

Sub-iteration 2 originally landed `counterRisk` at exactly **1.0**. The
field tables were fine — identical, cell for cell, to the 0.95 version — and the
3-map pilot was clean. The **aggressor self-mirror on crossroads then ran to the
1000-turn harness limit**, with p1 holding a 59–260% material lead for 915 turns
and 2,657,000 banked funds it could not spend because it was pinned at
`TIER3_UNIT_CAP`. The replay miner on that single log: `stalledUnit` 176 hits,
`heldLeadNoWin` 915 turns, `turnCapHit`. Iteration 9's failure mode, re-opened
by a persona weight.

Bisect (aggressor mirror, crossroads, seed 1, cap 300):

| config                                     | turns |
|--------------------------------------------|-------|
| i8 baseline (recon in, cr 0.7, floor 3)    | 97    |
| s1 only (recon out)                        | 61    |
| s1 + counterRisk 1.0 (floor 3)             | 169   |
| s1 + infantryFloor 4 (cr 0.7)              | 61    |
| s1 + cr 1.0 + floor 4                      | **>300** |

Neither lever breaks it alone; the pair does. And the sweep says the culprit is
the *value*, not the direction:

| counterRisk (floor 4) | crossroads | duel |
|-----------------------|------------|------|
| 0.85                  | 59         | 41   |
| 0.90                  | 87         | 41   |
| **0.95 (shipped)**    | **87**     | **41** |
| 1.00                  | **>300**   | 41   |
| 1.05                  | 236        | 41   |

`counterRisk = 1.00` is a knife-edge, not a threshold — 1.05 terminates in 236
turns and 0.95 in 87. In a self-mirror both sides evaluate identical positions,
so a weight that makes some comparison tie exactly produces two armies that
mirror each other's refusal indefinitely. **A tuning value that is a round
number is a candidate tie-maker, and only the mirror gate can see it**: 1.00 and
0.95 produce byte-identical 3-map and pairwise tables against the other three
personas. The shipped value is **0.95**, chosen for that reason alone.

### Probe gate (10 matches/cell/map, 3 land maps, bar 70%)

| persona   | probe-camper | probe-kiter | probe-rush | vs iteration 10 |
|-----------|--------------|-------------|------------|-----------------|
| aggressor | 100%         | 100%        | 100%       | unchanged       |
| balanced  | 90.0%        | 100%        | 100%       | unchanged       |
| economist | 86.7%        | 100%        | 100%       | unchanged       |
| turtle    | 70.0%        | 100%        | 100%       | unchanged       |

PASS — 12/12, and **no cell moved by a single match** from iterations 9 and 10.
Aggressor is 30-0-0 in all three of its columns. Turtle still sits exactly on the
bar (21-0-9 vs probe-camper, all draws); untouched here, still the field's
thinnest margin.

### Mirror termination (seed 1, `--max-turns 1000`, RAW winner)

| AI        | duel | crossroads |
|-----------|------|------------|
| utility   | 68   | 55         |
| balanced  | 44   | 101        |
| turtle    | 77   | 117        |
| aggressor | 41   | **87**     |

8/8 end on a board result well inside the 300-turn bar (aggressor's crossroads
mirror was >1000 before the recalibration above).

### Cross-generation (vs the frozen i8 field, 6/pair/map, 108 matches)

| persona      | overall | vs its own -i8 self |
|--------------|---------|---------------------|
| aggressor    | 66.7%   | **66.7%** (12-6)    |
| economist    | 55.6%   | 50.0% (9-9)         |
| economist-i8 | 55.6%   | —                   |
| aggressor-i8 | 22.2%   | —                   |

PASS on both halves of the gate. **Aggressor beats its own frozen self 12-6**
(66.7%, against the 38.9%-equivalent bar) and takes 67% off both economist
generations, where `aggressor-i8` takes 17%. `economist vs economist-i8` is
**exactly 50.0% and 9-9 on every map** — the byte-identical mirror, an
independent confirmation that economist was not touched (its config has now
survived four iterations untouched) and a live calibration check on the
benchmark plumbing. Zero cap-outs in the whole run.

The one cell worth reading closely is `aggressor vs aggressor-i8|duel` at 3-3:
the new aggressor sweeps crossroads 6-0 but only splits duel and canyon against
the version of itself that buys recon. Recon is not useless on a small map —
its 8 movement takes a neutral city on turn one — which is why the honest
statement is "the money was in the wrong band", not "recon is a bad unit".

### All-6-maps sanity (4/pair/map, 144 matches)

| persona   | all-6 WR |
|-----------|----------|
| aggressor | 66.7%    |
| balanced  | 58.3%    |
| economist | 47.2%    |
| turtle    | 27.8%    |

PASS on both bars. **No pairing dropped to 0%** — the lowest cell in the matrix
is 25%, in both directions, across all six maps. **All-cap cells: exactly
14/36**, on the iteration-7 baseline bar of ≤14/36: the twelve sea cells
(`armada` and `island_hop`, 12/12, unchanged since iteration 7 — no transports
doctrine, the standing strategic-design issue) plus the two highlands cells from
the wide pilot. Aggressor's own sea record is 4-0 on armada vs turtle and
economist but 0-4 vs balanced, and 0-4 on island_hop vs turtle: the ordering is a
LAND-map property, as scoped, and the sea maps re-shuffle it (balanced 58.3% >
economist 47.2% there).

### Degeneracy (`mine-replays`)

Same harness as iteration 10 (the 3-map post, 180 files):

| flag               | iter-10 post  | iter-11 post   |
|--------------------|---------------|----------------|
| turnCapHit         | 10 (5.6%)     | 10 (5.6%)      |
| heldLeadNoWin      | 20 (11.1%)    | 20 hits (8.3% of files) |
| uncontestedCapture | 70 (38.9%)    | 135 hits (47.2%) |
| stalledUnit        | 645 hits (66.7%) | 610 hits (66.7%) |

And on the wide pilot the gate requires (240 files):

| flag               | wide          |
|--------------------|---------------|
| turnCapHit         | 35 (14.6%)    |
| heldLeadNoWin      | 35 hits (10.4%) |
| uncontestedCapture | 250 hits (58.3%) |
| stalledUnit        | 1715 hits (75.0%) |

`turnCapHit` **misses the <10% bar on the wide set (14.6%) and meets it on the
3-map set (5.6%)** — every capped game outside the two cells iteration 10
already carried is on highlands. `stalledUnit` file-coverage is flat at 66.7%
(iteration 10 regressed it 44 → 67 and suspected balanced's infantry floor;
aggressor now has the same floor and coverage did not move, which weakens that
hypothesis — the hits per file fell, 645 → 610). `uncontestedCapture` rises
38.9% → 47.2%, and the miner names the mechanism in its own output: the top
entries are aggressor infantry taking **an enemy HQ** over turns 41–45 with
three idle enemy units in reach. That is not a defect on the capturing side; it
is the losing side failing to contest, and it is the flag that measures "games
end by someone actually winning".

### Suite

`npx vitest run`: **907/909 across 77 files.** The two failures are both the
documented `tests/ai-tier3-vs-tier1.test.ts` wall-clock flake
(`expectTurnBudget` at 499 ms against the 200 ms budget under a 77-file parallel
run); the file is **green solo**, both acceptances including the budget, and the
*win-rate* assertions never failed. As iteration 10 recorded, `makeAI('tier3')`
builds `utilityAI` with default weights and never reads `ai-personas.json`, so
no persona change can alter what that test simulates. `npm run lint` clean.

Two test files changed, both in the sanctioned way:

- `tests/ai-doctrine.test.ts` — new §7 (8 cases: 4 personas × 2 funds levels),
  committed red for aggressor and flipped by sub-iteration 1.
- `tests/ai-benchmarks.test.ts` — `aggressor` added to `RETUNED_SINCE_I8`. That
  snapshot-fidelity assertion is *designed* to fail when a persona is retuned and
  its own comment says the fix is to drop the expectation for the changed
  persona, never to re-freeze i8. **`economist` is now the only persona still
  byte-identical to the i8 freeze.**

### Known regressions and what is left

- **Two all-cap cells on highlands** (`turtle vs balanced`,
  `economist vs balanced`), and the wide-pilot `turnCapHit` rate at 14.6%
  against the <10% bar. Neither all-cap cell contains an aggressor game, both
  are pairings this iteration did not touch, and highlands was in no previous
  pilot's map set — this is newly *measured*, not newly *caused*. Not reachable
  from aggressor's config; it needs a balanced or turtle lever, or a look at why
  highlands is slow for artillery-heavy compositions.
- **Turtle is now 16.7% overall** (38.9% pre) and 13% on the wide pilot. That is
  the intended direction for the campaign ramp (turtle is mission 1) and every
  cell stays above the floor, but turtle is now the field's fragile persona: it
  wins exactly one game in six from everyone and sits exactly on the 70%
  probe-camper bar. Any future change touching turtle should re-run the probe
  gate first.
- **`uncontestedCapture` 38.9% → 47.2%.** More games are decided by a capture
  rather than a rout, which is the flag counting events. Worth a look only if it
  keeps climbing.
- Sea maps: unchanged and untargeted, 12/12 cells still 100% cap. The standing
  iteration-7 issue.
- Budget: **3 sub-iterations, as scoped**, plus one recalibration of
  sub-iteration 2's value forced by the mirror gate (1.0 → 0.95, identical field
  tables), four rejected levers screened at `--matches 2`, and one 5-point sweep
  of `counterRisk` against the mirror.

**Campaign impact.** Land-map ordering after this change: **aggressor 77.8% >
economist 55.6% > balanced 50.0% > turtle 16.7%** on the 3-map pilot, and
**aggressor 75.0% > economist 58.3% > balanced 50.0% > turtle 16.7%** on the
4-map wide pilot. The intended ramp **turtle < balanced < economist <
aggressor** **HOLDS, on both map sets, for the first time in this project.**

---

## Campaign coordination note (end of the WP1–WP7 programme)

Addressed to the campaign-mode workstream. This is the final entry of the AI
tuning programme; iterations 9, 10 and 11 all moved persona behaviour, and
campaign mode pins its opponents **by name**.

### Final 4×4 land matrix (row beats col), 240-match wide pilot

| row \ col | aggressor | turtle | economist | balanced | overall |
|-----------|-----------|--------|-----------|----------|---------|
| aggressor | —         | 75%    | 63%       | 88%      | **75.0%** |
| economist | 38%       | 88%    | —         | 50%      | **58.3%** |
| balanced  | 13%       | 88%    | 50%       | —        | **50.0%** |
| turtle    | 25%       | —      | 13%       | 13%      | **16.7%** |

(3-map standard pilot, same ordering: aggressor 77.8 > economist 55.6 >
balanced 50.0 > turtle 16.7. Every cell ≥10% in both directions on both runs.)

### Does the intended mission ramp hold?

**Yes — turtle < balanced < economist < aggressor, on both land pilots.**

| mission | opponent  | wide WR | ramp position |
|---------|-----------|---------|---------------|
| m1      | turtle    | 16.7%   | easiest ✓     |
| m2      | balanced  | 50.0%   | ✓             |
| m3      | economist | 58.3%   | ✓             |
| m4      | aggressor | 75.0%   | hardest ✓     |
| m5      | balanced  | 50.0%   | (repeat of m2) |

Two caveats worth designing around:

1. **m2 and m3 are close** (50.0% vs 58.3%, i.e. one game in eight). The ordering
   is correct but the *step* between missions 2 and 3 is small; missions 3 → 4 is
   the big jump.
2. **m5 repeats m2's opponent** and balanced has not changed since iteration 10.
   If mission 5 is meant to be the victory lap, it is currently easier than
   mission 4 by 25 pp.
3. This ordering is a **land-map** property. On `armada`/`island_hop` the field
   re-shuffles (aggressor 66.7 > balanced 58.3 > economist 47.2 > turtle 27.8)
   and every sea cell still runs to the turn cap. If any mission uses a sea map,
   its difficulty is not described by the table above.

### Mission difficulty shifted across iterations 9–11 — per-persona "feels" delta

Nothing in campaign code notices a persona retune. These are the deltas since
the campaign branch was cut (pre-iteration-9), one line each:

- **turtle (m1): much easier — 50.0% → 16.7%.** It stopped freezing its whole
  army behind a `futureThreat` wall (iteration 10) but never gained an offence;
  it now walls up, trades badly with armour, and loses on time. *Feels:* a
  passive opponent that no longer beats you by accident.
- **balanced (m2, m5): harder — 33.3% → 50.0%.** Dropped recon, gained artillery
  in its build band and a 4-infantry opening (iteration 10). *Feels:* it now
  answers a tank push with siege instead of scouts, and it contests captures
  instead of parking (iteration 8/9).
- **economist (m3): easier than its iteration-9 peak, harder than its original —
  77.8% → 94.4% → 58.3%.** **Its config was never touched in the entire
  programme**; all of that movement is the shared scorer (iteration 9's
  win-condition pricing) and the field improving around it. *Feels:* the same
  swarm-and-capture opponent, now beatable.
- **aggressor (m4): much harder — 38.9% → 16.7% → 75.0%.** Iterations 8 and 9
  cost it its free wins against passive opponents; iteration 11 stopped it
  buying recon, made it decline losing trades, and gave it a fourth capturer.
  *Feels:* the biggest behavioural change of the programme — it now shows up
  with tanks and infantry instead of scouts, and it takes your HQ around turn 45.

**Every persona in the game plays differently than it did when the campaign
missions were written, and mission difficulty moved silently in both
directions.** Missions should be re-playtested before release; the numbers above
are self-play win rates, not human-vs-AI difficulty.

### What did NOT change (the frozen contract, verified)

- **Persona names and count:** exactly `aggressor`, `balanced`, `economist`,
  `turtle`. `tests/ai-benchmarks.test.ts` pins `PERSONA_NAMES` to those four and
  asserts no probe or benchmark name leaks into `PERSONAS`; green.
- **Signatures:** `personaAI(name, { fog })` and `PERSONA_NAMES` untouched
  through all three iterations.
- **No persona key was renamed or removed** — iterations 9–11 only changed
  values inside existing keys (and `roleOverrides`/`buildPolicy` entries within
  them).
- **Every persona keeps its signature identity:** aggressor is still the
  damage-first tank push (`damageDealt 1.2`, `futureThreat 0.3`, the
  `frontline` override), economist is still the capture swarm (byte-identical to
  i8), turtle is still terrain-anchored defence, balanced is still the control
  persona. Iteration 11 removed a unit type from one build list, moved one
  weight by 0.25 and one floor by 1.

### Rebase reminder (unchanged from iteration 9)

The campaign branch is based pre-iteration-8 and must merge `main`. Its stale
copies of `src/engine/ai/utility.ts` and `src/engine/ai/roles.ts` are not
intentional edits — **resolve those two as take-main.** `ai-personas.json`
likewise: take-main.
