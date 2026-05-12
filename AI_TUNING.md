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

- Aggressor: real nerf. Drop `damageDealt` 1.4 → 1.2, raise `counterRisk`
  0.5 → 0.7, replace the second tank in preferred with infantry, raise
  `infantryFloor` 2 → 3 so it has actual capturers.
- Turtle: get away from artillery. preferred=[tank,infantry,artillery],
  raise `positional` 0.7 → 1.0 + `capture` 1.4 → 1.6 to spread captures.
- Economist: more teeth. damageDealt 1.0 → 1.1, tank earlier in preferred,
  keep infantryFloor 3 → 4.
- Balanced: still the control.

---

