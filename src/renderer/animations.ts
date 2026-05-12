// Animation queue.
//
// The engine state updates synchronously inside the reducer. The renderer's
// animation layer interpolates a visual representation of the change over a
// short window so the human player can follow what happened.
//
// Design notes:
// - Animations run serially. A new animation is enqueued and only starts when
//   the previous one's end-time has passed. While anything is animating the
//   `busy()` predicate returns true so input.ts can lock interaction.
// - Each animation carries pure render hints (unit id, path, etc.) — the
//   canvas layer reads them via `currentAnimations()` and overrides its
//   default drawing for the affected units.
// - We use `performance.now()` everywhere. Tests fake-time via vi.useFakeTimers.

import type { Coord, UnitId } from '../engine/core/types';
import { log } from '../engine/core/logger';

export type MoveAnim = {
  kind: 'move';
  unitId: UnitId;
  path: Coord[]; // from-tile to to-tile, inclusive
  startMs: number;
  durationMs: number;
};

export type AttackAnim = {
  kind: 'attack';
  attackerId: UnitId;
  targetId: UnitId;
  startMs: number;
  durationMs: number;
};

export type DeathAnim = {
  kind: 'death';
  unitId: UnitId;
  /** Final tile to fade out on. */
  pos: Coord;
  startMs: number;
  durationMs: number;
};

export type Anim = MoveAnim | AttackAnim | DeathAnim;

export type AnimationQueueDeps = {
  /** Called when the queue transitions from empty -> active or active -> empty. */
  onBusyChange?: (busy: boolean) => void;
  /** Called when an animation starts/ends (one event per anim). */
  onEvent?: (event: { type: 'start' | 'end'; kind: Anim['kind'] }) => void;
  /** Time source for tests. Defaults to `performance.now`. */
  now?: () => number;
  /** Render-tick after each enqueue so a paused queue resumes. */
  onTick?: () => void;
};

export const MOVE_MS = 300;
export const ATTACK_MS = 250;
export const DEATH_MS = 200;

export type AnimationQueue = {
  enqueueMove(unitId: UnitId, path: Coord[]): void;
  enqueueAttack(attackerId: UnitId, targetId: UnitId): void;
  enqueueDeath(unitId: UnitId, pos: Coord): void;
  /** Active animations (still running at `now()`). */
  active(): Anim[];
  /** True if any animation is in progress or scheduled in the future. */
  busy(): boolean;
  /** Advance to current time, drop finished animations, fire `end` events. */
  tick(): void;
  /** Drop everything immediately. */
  clear(): void;
};

export function createAnimationQueue(deps: AnimationQueueDeps = {}): AnimationQueue {
  const now = deps.now ?? ((): number => performance.now());
  const queue: Anim[] = [];
  /** Cursor for the earliest start time the NEXT enqueued animation may use. */
  let nextStart = 0;
  let wasBusy = false;
  /** Animations that have already had their `start` event fired. */
  const started = new WeakSet<Anim>();
  /** Animations that have already had their `end` event fired. */
  const ended = new WeakSet<Anim>();

  function setBusy(b: boolean): void {
    if (b !== wasBusy) {
      wasBusy = b;
      deps.onBusyChange?.(b);
    }
  }

  function schedule(anim: Anim): void {
    const t = now();
    const start = Math.max(t, nextStart);
    anim.startMs = start;
    nextStart = start + anim.durationMs;
    queue.push(anim);
    log('render', 'animation enqueued', { kind: anim.kind, start });
    setBusy(true);
    deps.onTick?.();
  }

  function tick(): void {
    const t = now();
    // Fire start events for animations whose startMs has passed.
    for (const a of queue) {
      if (!started.has(a) && t >= a.startMs) {
        started.add(a);
        deps.onEvent?.({ type: 'start', kind: a.kind });
        log('render', 'animation started', { kind: a.kind });
      }
    }
    // Drop animations whose end time has passed.
    for (let i = queue.length - 1; i >= 0; i--) {
      const a = queue[i]!;
      if (t >= a.startMs + a.durationMs) {
        if (!ended.has(a)) {
          ended.add(a);
          deps.onEvent?.({ type: 'end', kind: a.kind });
          log('render', 'animation ended', { kind: a.kind });
        }
        queue.splice(i, 1);
      }
    }
    if (queue.length === 0) setBusy(false);
  }

  return {
    enqueueMove(unitId, path): void {
      schedule({ kind: 'move', unitId, path, startMs: 0, durationMs: MOVE_MS });
    },
    enqueueAttack(attackerId, targetId): void {
      schedule({
        kind: 'attack',
        attackerId,
        targetId,
        startMs: 0,
        durationMs: ATTACK_MS,
      });
    },
    enqueueDeath(unitId, pos): void {
      schedule({ kind: 'death', unitId, pos, startMs: 0, durationMs: DEATH_MS });
    },
    active(): Anim[] {
      const t = now();
      return queue.filter((a) => t >= a.startMs && t < a.startMs + a.durationMs);
    },
    busy(): boolean {
      return queue.length > 0;
    },
    tick,
    clear(): void {
      queue.length = 0;
      nextStart = 0;
      setBusy(false);
    },
  };
}
