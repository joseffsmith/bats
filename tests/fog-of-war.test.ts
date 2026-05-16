// Fog-of-war acceptance.
//
// Visibility-selector matrix (per the plan):
//   - infantry sees Manhattan-2
//   - recon sees Manhattan-5
//   - owned city contributes a 4-neighbour vision disk
//   - friendlies always visible (even without a spotter)
//   - enemy on a hidden tile is masked by isVisibleTo / visibleUnitAt under fog
//   - submerged-sub stealth still wins over fog vision (existing rule preserved)
//
// Plus a determinism check: two fog-on AI matches with the same seed must
// produce identical action traces.

import { describe, expect, it } from 'vitest';
import { makeState } from './test-helpers';
import {
  hiddenTiles,
  isTileVisible,
  isVisibleTo,
  viewStateForPlayer,
  visibleTiles,
  visibleUnitAt,
} from '../src/engine/queries/selectors';
import duelMap from '../src/data/maps/duel.json';
import { runMatch } from '../src/cli/run-match';

describe('fog-of-war: visibleTiles matrix', () => {
  it('infantry sees Manhattan-2 around its position', () => {
    const s = makeState({
      width: 9,
      height: 9,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 8, y: 8 } },
      ],
      units: [{ type: 'infantry', owner: 0, pos: { x: 4, y: 4 } }],
    });
    const v = visibleTiles(s, 0);
    // Every Manhattan-2 tile around (4,4) is visible …
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > 2) continue;
        expect(v.has(`${4 + dx},${4 + dy}`)).toBe(true);
      }
    }
    // … and Manhattan-3 is not (modulo the HQ vision disk far away).
    expect(v.has('7,4')).toBe(false);
    expect(v.has('4,7')).toBe(false);
  });

  it('recon sees Manhattan-5 around its position', () => {
    const s = makeState({
      width: 13,
      height: 13,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 12, y: 12 } },
      ],
      units: [{ type: 'recon', owner: 0, pos: { x: 6, y: 6 } }],
    });
    const v = visibleTiles(s, 0);
    expect(v.has('11,6')).toBe(true); // distance 5
    expect(v.has('6,11')).toBe(true); // distance 5
    expect(v.has('12,6')).toBe(false); // distance 6 — out of range
  });

  it('owned city contributes 4-neighbour vision', () => {
    const s = makeState({
      width: 6,
      height: 6,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 5 } },
      ],
      tiles: [{ pos: { x: 3, y: 3 }, terrain: 'city', owner: 0 }],
    });
    const v = visibleTiles(s, 0);
    expect(v.has('3,3')).toBe(true); // the city itself
    expect(v.has('2,3')).toBe(true);
    expect(v.has('4,3')).toBe(true);
    expect(v.has('3,2')).toBe(true);
    expect(v.has('3,4')).toBe(true);
    // One past the orthogonal neighbour is dark.
    expect(v.has('5,3')).toBe(false);
  });

  it('friendlies are always visible even outside the vision disk', () => {
    const s = makeState({
      width: 12,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 11, y: 0 } },
      ],
      units: [
        // The only friendly: an infantry at column 0 with a 2-tile disk.
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        // Another friendly far away — still visible to player 0.
        { type: 'infantry', owner: 0, pos: { x: 10, y: 0 } },
      ],
    });
    const farFriend = Object.values(s.units).find((u) => u.pos.x === 10)!;
    expect(isVisibleTo(s, farFriend, 0, /* fog */ true)).toBe(true);
  });

  it('enemy on a hidden tile is masked under fog', () => {
    const s = makeState({
      width: 10,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 9, y: 0 } },
      ],
      units: [
        { type: 'infantry', owner: 0, pos: { x: 0, y: 0 } },
        // 5 tiles away — outside infantry vision-2 + property vision-1.
        { type: 'infantry', owner: 1, pos: { x: 5, y: 0 } },
      ],
    });
    const enemy = Object.values(s.units).find((u) => u.owner === 1)!;
    expect(isVisibleTo(s, enemy, 0, /* fog */ true)).toBe(false);
    expect(visibleUnitAt(s, enemy.pos, 0, /* fog */ true)).toBeUndefined();
    // Without fog, the unit IS visible (pre-existing behaviour).
    expect(isVisibleTo(s, enemy, 0)).toBe(true);
    expect(visibleUnitAt(s, enemy.pos, 0)).toBeDefined();
  });

  it('isTileVisible mirrors visibleTiles', () => {
    const s = makeState({
      width: 5,
      height: 5,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 4, y: 4 } },
      ],
      units: [{ type: 'infantry', owner: 0, pos: { x: 2, y: 2 } }],
    });
    expect(isTileVisible(s, { x: 2, y: 2 }, 0)).toBe(true);
    // Distance 3 from the infantry — outside its vision disk and far from HQ.
    expect(isTileVisible(s, { x: 0, y: 4 }, 0)).toBe(false);
  });

  it('hiddenTiles is the complement of visibleTiles', () => {
    const s = makeState({
      width: 4,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 3, y: 0 } },
      ],
      units: [{ type: 'infantry', owner: 0, pos: { x: 0, y: 0 } }],
    });
    const vis = visibleTiles(s, 0);
    const hid = hiddenTiles(s, 0);
    for (let x = 0; x < 4; x++) {
      expect(vis.has(`${x},0`) !== hid.has(`${x},0`)).toBe(true);
    }
  });

  it('submerged-sub stealth still applies under fog (cruiser spotter reveals)', () => {
    const s = makeState({
      width: 6,
      height: 1,
      defaultTerrain: 'sea',
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 5, y: 0 } },
      ],
      tiles: [{ pos: { x: 0, y: 0 }, terrain: 'hq', owner: 0 }],
      units: [
        // Enemy sub at column 3, submerged.
        { type: 'submarine', owner: 1, pos: { x: 3, y: 0 } },
        // Our cruiser adjacent.
        { type: 'cruiser', owner: 0, pos: { x: 2, y: 0 } },
      ],
    });
    // Force the sub submerged.
    const sub = Object.values(s.units).find((u) => u.type === 'submarine')!;
    sub.submerged = true;
    // Under fog, with the spotter adjacent, the sub IS visible.
    expect(isVisibleTo(s, sub, 0, /* fog */ true)).toBe(true);
  });
});

describe('fog-of-war: viewStateForPlayer', () => {
  it('keeps own + visible enemies as-is; stamps hidden enemies with fog sentinel', async () => {
    const { FOG_HIDDEN_SENTINEL } = await import('../src/engine/queries/selectors');
    const s = makeState({
      width: 12,
      height: 1,
      hqs: [
        { owner: 0, pos: { x: 0, y: 0 } },
        { owner: 1, pos: { x: 11, y: 0 } },
      ],
      units: [
        { type: 'recon', owner: 0, pos: { x: 1, y: 0 } }, // sees up to col 6
        { type: 'infantry', owner: 1, pos: { x: 5, y: 0 } }, // visible
        { type: 'infantry', owner: 1, pos: { x: 9, y: 0 } }, // hidden
      ],
    });
    const view = viewStateForPlayer(s, 0);
    // Hidden enemies REMAIN in the dict so checkWinner doesn't declare a
    // bogus rout when no enemies are visible. They're marked loadedIn so
    // attackableTargets / unitAt / threat-map / pathfinding skip them.
    const visEnemy = view.units['u2']!;
    const hidEnemy = view.units['u3']!;
    expect(visEnemy.loadedIn).toBeUndefined();
    expect(hidEnemy.loadedIn).toBe(FOG_HIDDEN_SENTINEL);
    // Own unit untouched.
    expect(view.units['u1']!.loadedIn).toBeUndefined();
  });
});

describe('fog-of-war: AI determinism with fog on', () => {
  it('utility-vs-utility with same seed produces identical traces under fog', async () => {
    const opts = {
      mapName: 'duel',
      maxTurns: 80,
      seed: 7,
      mapJson: duelMap,
      writeLog: false,
      p0: { name: 'utility' as const, fog: true },
      p1: { name: 'utility' as const, fog: true },
    };
    const a = await runMatch(opts);
    const b = await runMatch(opts);
    expect(b.actions).toEqual(a.actions);
    expect(b.turns).toBe(a.turns);
    expect(b.winner).toBe(a.winner);
  });
});
