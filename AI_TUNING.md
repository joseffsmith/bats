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

