// Animation queue.
//
// The engine state updates synchronously inside the reducer. The renderer's
// animation layer interpolates a visual representation of the change over a
// short window so the human player can follow what happened.
//
// Phase 6 polish additions:
//   - Move animations use `easeInOutCubic` instead of linear t for the
//     intra-segment interpolant (see canvas.ts).
//   - Attack animations expose a `flashIntensity()` helper driven by
//     `easeOutBack` so the defender's white flash overshoots and snaps back.
//   - Death animations now ship with a small radial particle field generated
//     once at enqueue time (deterministic — same path every tick).
//   - HP tween: when a unit takes damage, an HPTweenAnim runs for 200ms so the
//     bar slides from old to new fill instead of snapping.
//   - Camera shake: ATTACK animations whose damage > 40 HP enqueue a CameraShake
//     that the renderer can read via `shakeOffset()`.
//
// Design notes (unchanged):
// - Animations run serially. A new animation is enqueued and only starts when
//   the previous one's end-time has passed. While anything is animating the
//   `busy()` predicate returns true so input.ts can lock interaction.
// - Each animation carries pure render hints (unit id, path, etc.) — the
//   canvas layer reads them via `currentAnimations()` and overrides its
//   default drawing for the affected units.
// - We use `performance.now()` everywhere. Tests fake-time via vi.useFakeTimers.

import type { Coord, UnitId } from '../engine/core/types';
import { log } from '../engine/core/logger';
import { easeOutBack } from './easing';

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
  /** Frozen at enqueue time so the projectile arc survives mid-flight deaths. */
  attackerPos?: Coord;
  targetPos?: Coord;
  /** Predicted damage values, used by the floating damage labels. */
  damageDealt?: number;
  counterReceived?: number;
  /** True for indirect-fire units (artillery). Renderer draws a parabolic arc
   *  and we use a longer duration so the projectile has time to travel. */
  arc?: boolean;
  startMs: number;
  durationMs: number;
};

export type DeathParticle = {
  /** Velocity in tile-fractions per second (rendered as pixels by scaling tileSize). */
  vx: number;
  vy: number;
  /** Initial offset within the tile, [0,1). */
  ox: number;
  oy: number;
};

export type DeathAnim = {
  kind: 'death';
  unitId: UnitId;
  /** Final tile to fade out on. */
  pos: Coord;
  startMs: number;
  durationMs: number;
  particles: DeathParticle[];
};

export type HpTweenAnim = {
  kind: 'hpTween';
  unitId: UnitId;
  fromHp: number;
  toHp: number;
  startMs: number;
  durationMs: number;
};

export type CameraShakeAnim = {
  kind: 'shake';
  magnitudePx: number;
  startMs: number;
  durationMs: number;
};

/** Visual-less sentinel that blocks the queue cursor for a short beat after a
 *  big hit. Renderer ignores it; its only effect is delaying subsequent
 *  blocking anims (death, next attack). */
export type HitPauseAnim = {
  kind: 'hitPause';
  startMs: number;
  durationMs: number;
};

/** Floating "-NN" label that rises and fades over the defender's tile. */
export type DamageLabelAnim = {
  kind: 'damageLabel';
  /** Tile the label spawns from. */
  pos: Coord;
  /** Absolute damage value to display (positive integer). */
  value: number;
  /** Heavy hits use a different colour treatment. */
  big: boolean;
  startMs: number;
  durationMs: number;
};

/** Radial pulse over a capturable tile when ownership flips. */
export type CaptureFlashAnim = {
  kind: 'captureFlash';
  pos: Coord;
  /** New owner; renderer pulses in their palette colour. */
  newOwner: 0 | 1;
  startMs: number;
  durationMs: number;
};

export type Anim =
  | MoveAnim
  | AttackAnim
  | DeathAnim
  | HpTweenAnim
  | CameraShakeAnim
  | HitPauseAnim
  | DamageLabelAnim
  | CaptureFlashAnim;

export type AnimationQueueDeps = {
  /** Called when the queue transitions from empty -> active or active -> empty. */
  onBusyChange?: (busy: boolean) => void;
  /** Called when an animation starts/ends (one event per anim). */
  onEvent?: (event: { type: 'start' | 'end'; kind: Anim['kind'] }) => void;
  /** Time source for tests. Defaults to `performance.now`. */
  now?: () => number;
  /** Render-tick after each enqueue so a paused queue resumes. */
  onTick?: () => void;
  /** Optional deterministic RNG for particle directions; defaults to Math.random. */
  random?: () => number;
};

export const MOVE_MS = 300;
export const ATTACK_MS = 250;
/** Longer duration for indirect-fire attacks so the parabolic projectile has
 *  time to arc visibly. */
export const ATTACK_ARC_MS = 420;
export const DEATH_MS = 400;
export const HP_TWEEN_MS = 200;
export const SHAKE_MS = 150;
export const SHAKE_THRESHOLD_HP = 40;
export const SHAKE_MAGNITUDE_PX = 2;
export const DEATH_PARTICLE_COUNT = 10;
/** Projectile flight time as a fraction of the parent AttackAnim duration. The
 *  remaining window is spent on impact + flash. */
export const PROJECTILE_FRACTION = 0.45;
/** Muzzle flash duration as a fraction of the parent AttackAnim duration. */
export const MUZZLE_FLASH_FRACTION = 0.18;
/** Beat of silence after a big hit before death/next anim plays. */
export const HIT_PAUSE_MS = 80;
/** Damage threshold (HP) for triggering a hit pause + big-impact visuals. */
export const HIT_PAUSE_THRESHOLD_HP = 30;
/** Floating damage-label lifespan. */
export const DAMAGE_LABEL_MS = 650;
/** Capture-flash radial pulse lifespan. */
export const CAPTURE_FLASH_MS = 520;

export type AttackEnqueueOpts = {
  /** Attacker tile at attack time (renderer needs the launch point). */
  attackerPos?: Coord;
  /** Target tile at attack time (renderer needs the impact point). */
  targetPos?: Coord;
  /** Predicted damage dealt to target. Drives the floating "-NN" label. */
  damageDealt?: number;
  /** Predicted counter damage received by attacker. Drives a label on the
   *  attacker's tile too. */
  counterReceived?: number;
  /** Indirect-fire unit (artillery, battleship): projectile follows a
   *  parabolic arc and the anim lasts longer. */
  arc?: boolean;
};

export type AnimationQueue = {
  enqueueMove(unitId: UnitId, path: Coord[]): void;
  enqueueAttack(attackerId: UnitId, targetId: UnitId, opts?: AttackEnqueueOpts): void;
  enqueueDeath(unitId: UnitId, pos: Coord): void;
  /** HP bar tween. `delayMs` lets the caller align the slide with the impact
   *  moment of a preceding attack (rather than the swing). */
  enqueueHpTween(unitId: UnitId, fromHp: number, toHp: number, delayMs?: number): void;
  /** Enqueue a camera-shake parallel to the in-flight ATTACK (does not block).
   *  `delayMs` aligns the shake with the impact moment. */
  enqueueShake(magnitudePx?: number, delayMs?: number): void;
  /** Block the queue cursor for `durationMs` after the current chain. */
  enqueueHitPause(durationMs?: number): void;
  /** Floating damage label that rises + fades over `pos`. */
  enqueueDamageLabel(pos: Coord, value: number, big: boolean, delayMs?: number): void;
  /** Radial pulse over a tile when it flips ownership. */
  enqueueCaptureFlash(pos: Coord, newOwner: 0 | 1): void;
  /** Active animations (still running at `now()`). */
  active(): Anim[];
  /** True if any *blocking* animation is in progress or scheduled in the future. */
  busy(): boolean;
  /** Advance to current time, drop finished animations, fire `end` events. */
  tick(): void;
  /** Drop everything immediately. */
  clear(): void;
  /** Current camera shake offset (CSS pixels). Zero when no shake is active. */
  shakeOffset(): { dx: number; dy: number };
  /** Compute attack-flash intensity for the given target id (0..~1.05 with overshoot). */
  flashIntensity(targetId: UnitId): number;
};

/**
 * Create the deterministic per-enqueue particle layout. Pure given `random`.
 *
 * Particles spread radially with a slight randomised angle jitter and a
 * uniform-ish speed band. Render code consumes vx/vy as tile-fractions/second.
 */
export function createDeathParticles(
  random: () => number,
  count: number = DEATH_PARTICLE_COUNT,
): DeathParticle[] {
  const out: DeathParticle[] = [];
  for (let i = 0; i < count; i++) {
    // Evenly spaced base angle plus a small jitter — keeps the "radial" look
    // while avoiding a perfect ring.
    const base = (i / count) * Math.PI * 2;
    const jitter = (random() - 0.5) * 0.4;
    const angle = base + jitter;
    const speed = 0.8 + random() * 0.6; // tile-fractions per second
    out.push({
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      ox: 0.5,
      oy: 0.5,
    });
  }
  return out;
}

export function createAnimationQueue(deps: AnimationQueueDeps = {}): AnimationQueue {
  const now = deps.now ?? ((): number => performance.now());
  const random = deps.random ?? Math.random;
  const queue: Anim[] = [];
  /** Cursor for the earliest start time the NEXT blocking enqueued animation may use. */
  let nextBlockingStart = 0;
  let wasBusy = false;
  /** Animations that have already had their `start` event fired. */
  const started = new WeakSet<Anim>();
  /** Animations that have already had their `end` event fired. */
  const ended = new WeakSet<Anim>();

  function isBlocking(kind: Anim['kind']): boolean {
    // HP tween, camera shake, damage labels, and capture flashes run alongside
    // the main animation chain; they do not gate input or advance the cursor.
    // hitPause IS blocking — it exists to delay the chain.
    return (
      kind !== 'hpTween' &&
      kind !== 'shake' &&
      kind !== 'damageLabel' &&
      kind !== 'captureFlash'
    );
  }

  function setBusy(b: boolean): void {
    if (b !== wasBusy) {
      wasBusy = b;
      deps.onBusyChange?.(b);
    }
  }

  function scheduleBlocking(anim: Anim): void {
    const t = now();
    const start = Math.max(t, nextBlockingStart);
    anim.startMs = start;
    nextBlockingStart = start + anim.durationMs;
    queue.push(anim);
    log('render', 'animation enqueued', { kind: anim.kind, start });
    setBusy(true);
    deps.onTick?.();
  }

  function scheduleParallel(anim: Anim, delayMs: number = 0): void {
    // Parallel anims start as soon as possible (now + delay) and don't push
    // the cursor. `delayMs` lets the caller align with the impact moment of a
    // preceding attack.
    const t = now() + Math.max(0, delayMs);
    anim.startMs = t;
    queue.push(anim);
    log('render', 'animation enqueued (parallel)', { kind: anim.kind, start: t });
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
    // We're "busy" only while a blocking animation is pending.
    const hasBlocking = queue.some((a) => isBlocking(a.kind));
    if (!hasBlocking) setBusy(false);
  }

  return {
    enqueueMove(unitId, path): void {
      scheduleBlocking({
        kind: 'move',
        unitId,
        path,
        startMs: 0,
        durationMs: MOVE_MS,
      });
    },
    enqueueAttack(attackerId, targetId, opts): void {
      const arc = opts?.arc ?? false;
      const anim: AttackAnim = {
        kind: 'attack',
        attackerId,
        targetId,
        arc,
        startMs: 0,
        durationMs: arc ? ATTACK_ARC_MS : ATTACK_MS,
      };
      if (opts?.attackerPos) anim.attackerPos = opts.attackerPos;
      if (opts?.targetPos) anim.targetPos = opts.targetPos;
      if (opts?.damageDealt !== undefined) anim.damageDealt = opts.damageDealt;
      if (opts?.counterReceived !== undefined) anim.counterReceived = opts.counterReceived;
      scheduleBlocking(anim);
    },
    enqueueDeath(unitId, pos): void {
      scheduleBlocking({
        kind: 'death',
        unitId,
        pos,
        startMs: 0,
        durationMs: DEATH_MS,
        particles: createDeathParticles(random),
      });
    },
    enqueueHpTween(unitId, fromHp, toHp, delayMs = 0): void {
      // Skip no-ops.
      if (fromHp === toHp) return;
      scheduleParallel(
        {
          kind: 'hpTween',
          unitId,
          fromHp,
          toHp,
          startMs: 0,
          durationMs: HP_TWEEN_MS,
        },
        delayMs,
      );
    },
    enqueueShake(magnitudePx = SHAKE_MAGNITUDE_PX, delayMs = 0): void {
      scheduleParallel(
        {
          kind: 'shake',
          magnitudePx,
          startMs: 0,
          durationMs: SHAKE_MS,
        },
        delayMs,
      );
    },
    enqueueHitPause(durationMs = HIT_PAUSE_MS): void {
      scheduleBlocking({
        kind: 'hitPause',
        startMs: 0,
        durationMs,
      });
    },
    enqueueDamageLabel(pos, value, big, delayMs = 0): void {
      scheduleParallel(
        {
          kind: 'damageLabel',
          pos,
          value,
          big,
          startMs: 0,
          durationMs: DAMAGE_LABEL_MS,
        },
        delayMs,
      );
    },
    enqueueCaptureFlash(pos, newOwner): void {
      scheduleParallel({
        kind: 'captureFlash',
        pos,
        newOwner,
        startMs: 0,
        durationMs: CAPTURE_FLASH_MS,
      });
    },
    active(): Anim[] {
      const t = now();
      return queue.filter((a) => t >= a.startMs && t < a.startMs + a.durationMs);
    },
    busy(): boolean {
      return queue.some((a) => isBlocking(a.kind));
    },
    tick,
    clear(): void {
      queue.length = 0;
      nextBlockingStart = 0;
      setBusy(false);
    },
    shakeOffset(): { dx: number; dy: number } {
      const t = now();
      let dx = 0;
      let dy = 0;
      for (const a of queue) {
        if (a.kind !== 'shake') continue;
        const elapsed = t - a.startMs;
        if (elapsed < 0 || elapsed >= a.durationMs) continue;
        const k = 1 - elapsed / a.durationMs; // decay
        // Two orthogonal sinusoids at slightly different frequencies so the
        // shake doesn't look diagonal-only.
        dx += Math.sin(elapsed * 0.08) * a.magnitudePx * k;
        dy += Math.cos(elapsed * 0.11) * a.magnitudePx * k;
      }
      return { dx, dy };
    },
    flashIntensity(targetId: UnitId): number {
      const t = now();
      for (const a of queue) {
        if (a.kind !== 'attack') continue;
        if (a.targetId !== targetId) continue;
        const elapsed = t - a.startMs;
        if (elapsed < 0 || elapsed >= a.durationMs) continue;
        return easeOutBack(elapsed / a.durationMs);
      }
      return 0;
    },
  };
}
