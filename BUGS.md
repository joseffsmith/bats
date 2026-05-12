# Phase 1 Bugs

Tracked by the tester. Builder/fixer triages.

---

## Bug 1 — Spurious rout winner when both players have 0 units

**File:** `src/engine/systems/win.ts` → `checkWinner`
**Status:** Fixed (Phase 1 commit). Tracked by `test.fails(...)` in `tests/win-acceptance.test.ts`
("BUG: checkWinner reports spurious winner when BOTH players have 0 units").

### Expected (per PLAN.md)

> Rout: a player with zero units loses.

If *both* players have zero units there is no living unit for either side
— neither has anyone to win the field. The most defensible behaviour is to
report **no winner** (null) in that case (effectively a draw). At minimum,
the result should be deterministic and not silently favour P1.

### Actual

`checkWinner` iterates `[0, 1]` and on the first `(counts[p] === 0)` hit
returns `otherPlayer(p)`. With both at zero, p=0 hits first and the
function returns `1`. This means:

- Calling `reduce(state, action)` on any state where both players have 0
  units (e.g. a test fixture created by `createInitialState({units: []})`)
  immediately stamps `state.winner = 1` after the first legal action.
- Any test that forgets to seed dummy units on both sides will
  unexpectedly hit a P1 rout-win on its very first END_TURN.

### Minimal repro

```ts
import { makeState } from './tests/test-helpers';
import { checkWinner } from './src/engine/systems/win';

const s = makeState({
  width: 3,
  height: 1,
  hqs: [
    { owner: 0, pos: { x: 0, y: 0 } },
    { owner: 1, pos: { x: 2, y: 0 } },
  ],
  units: [],
});

// EXPECTED: null (both empty → draw / no winner)
// ACTUAL:   1
console.log(checkWinner(s));
```

### Suggested fix

Either:

1. (Cleanest) Return `null` when *both* sides have zero units.
2. Or refuse to check rout until at least one unit has ever existed
   (track a `unitsHaveExisted` flag — heavier).

Option 1 is one line:

```ts
if (counts[0] === 0 && counts[1] === 0) return null;
for (const p of [0, 1] as PlayerId[]) { ... }
```

Caller code (the reducer) is unaffected.

---

## Bug 2 — Unknown action types throw a TypeError instead of being a no-op

**File:** `src/engine/core/validators.ts` → `isLegalAction` *and*
`src/engine/core/reducer.ts` → `reduce`.
**Status:** Fixed (Phase 1 commit). Tracked by `test.fails(...)` in
`tests/reducer-purity.test.ts` ("BUG: unknown action type should be a no-op
but throws TypeError").

### Expected (per PLAN.md & reducer.ts docstring)

> "Illegal actions are NO-OPS: the original state is returned unchanged
> and the rejection reason is logged. (See validators.ts for rationale.)"

A junk action — e.g. `{ type: 'NOPE' }` — should be classified as illegal
and produce a logged no-op. This is important for tolerating stale UI
clicks, AI bugs, replay-format drift, etc.

### Actual

`isLegalAction` is a `switch` whose `case`s are the known action types
with no `default` branch — so on an unknown `action.type` the function
falls off the end and (under TS strict mode) returns `undefined`. The
reducer then does:

```ts
const legality = isLegalAction(state, action);
if (!legality.legal) { ... }     // TypeError: legality is undefined
```

Result: the reducer throws `TypeError: Cannot read properties of
undefined (reading 'legal')`.

### Minimal repro

```ts
import { reduce } from './src/engine/core/reducer';
// state has been constructed elsewhere…
reduce(state, { type: 'NOPE' } as any);
// TypeError thrown.
```

### Suggested fix

Add a `default` arm to `isLegalAction`:

```ts
export function isLegalAction(state, action): LegalityResult {
  if (state.winner !== null) return illegal('game over');
  switch (action.type) {
    case 'MOVE':     return checkMove(state, action);
    case 'ATTACK':   return checkAttack(state, action);
    case 'CAPTURE':  return checkCapture(state, action);
    case 'BUILD':    return checkBuild(state, action);
    case 'WAIT':     return checkWait(state, action);
    case 'END_TURN': return { legal: true };
    default:         return illegal('unknown action type');
  }
}
```

The reducer's own `switch` already has no `default` either, but with
`isLegalAction` returning `{legal: false, …}` the reducer will bail
before reaching that switch.

---
