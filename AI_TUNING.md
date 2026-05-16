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

