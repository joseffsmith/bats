// @vitest-environment jsdom
//
// Phase 6 animation tests.
//
// Covers:
//   - easing functions: input ↔ output for known anchor points.
//   - queue serial behaviour: blocking anims advance the cursor; parallel
//     (HP tween, shake) do not.
//   - a full ATTACK timeline: enqueue attack + HP tween + shake, drive
//     time forward, and confirm flashIntensity/shakeOffset/HP-tween values
//     evolve as expected.
//   - death particle generation is deterministic per seed.

import { describe, expect, it } from 'vitest';
import {
  ATTACK_MS,
  DEATH_MS,
  HP_TWEEN_MS,
  MOVE_MS,
  SHAKE_MS,
  createAnimationQueue,
  createDeathParticles,
} from '../src/renderer/animations';
import { easeInOutCubic, easeOutBack } from '../src/renderer/easing';

describe('easing functions', () => {
  it('easeInOutCubic anchors: f(0)=0, f(0.5)=0.5, f(1)=1', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6);
    expect(easeInOutCubic(1)).toBe(1);
  });

  it('easeInOutCubic clamps inputs outside [0,1]', () => {
    expect(easeInOutCubic(-0.5)).toBe(0);
    expect(easeInOutCubic(1.5)).toBe(1);
  });

  it('easeInOutCubic is monotone increasing on a coarse grid', () => {
    let prev = -Infinity;
    for (let t = 0; t <= 1; t += 0.05) {
      const v = easeInOutCubic(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('easeOutBack overshoots past 1 in the middle of the curve', () => {
    expect(easeOutBack(0)).toBe(0);
    expect(easeOutBack(1)).toBe(1);
    // The Penner constant-driven curve peaks above 1 around t ≈ 0.7.
    const peak = easeOutBack(0.7);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.2);
  });

  it('easeOutBack clamps inputs outside [0,1]', () => {
    expect(easeOutBack(-1)).toBe(0);
    expect(easeOutBack(2)).toBe(1);
  });
});

describe('animation queue', () => {
  it('chains blocking animations serially', () => {
    let t = 0;
    const queue = createAnimationQueue({ now: () => t });
    queue.enqueueMove('u1', [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    queue.enqueueAttack('u1', 'u2');
    const active1 = queue.active();
    expect(active1[0]?.kind).toBe('move');

    t = MOVE_MS - 1;
    queue.tick();
    expect(queue.busy()).toBe(true);

    t = MOVE_MS + 1;
    queue.tick();
    expect(queue.active()[0]?.kind).toBe('attack');

    t = MOVE_MS + ATTACK_MS + 1;
    queue.tick();
    expect(queue.busy()).toBe(false);
  });

  it('HP tween + shake run in parallel and do not gate input', () => {
    let t = 0;
    const queue = createAnimationQueue({ now: () => t });
    queue.enqueueHpTween('u1', 100, 50);
    queue.enqueueShake();
    // Parallel-only: busy() should be false.
    expect(queue.busy()).toBe(false);
    // Both should be active.
    const active = queue.active();
    expect(active.some((a) => a.kind === 'hpTween')).toBe(true);
    expect(active.some((a) => a.kind === 'shake')).toBe(true);
    t = HP_TWEEN_MS + 1;
    queue.tick();
    expect(queue.active().some((a) => a.kind === 'hpTween')).toBe(false);
  });

  it('flashIntensity follows easeOutBack across an ATTACK', () => {
    let t = 0;
    const queue = createAnimationQueue({ now: () => t });
    queue.enqueueAttack('atk', 'tgt');
    queue.tick();
    expect(queue.flashIntensity('tgt')).toBe(easeOutBack(0));
    t = ATTACK_MS * 0.5;
    queue.tick();
    expect(queue.flashIntensity('tgt')).toBeCloseTo(easeOutBack(0.5), 5);
    t = ATTACK_MS + 1;
    queue.tick();
    expect(queue.flashIntensity('tgt')).toBe(0);
  });

  it('shakeOffset is non-zero during a shake and decays', () => {
    let t = 0;
    const queue = createAnimationQueue({ now: () => t });
    queue.enqueueShake(2);
    t = SHAKE_MS * 0.3;
    const mid = queue.shakeOffset();
    // At t=45ms with magnitude 2, sin(0.08*45) ≈ sin(3.6), value clearly nonzero.
    expect(Math.abs(mid.dx) + Math.abs(mid.dy)).toBeGreaterThan(0.01);
    t = SHAKE_MS + 5;
    queue.tick();
    expect(queue.shakeOffset()).toEqual({ dx: 0, dy: 0 });
  });

  it('skips no-op HP tween (from === to)', () => {
    const queue = createAnimationQueue({ now: () => 0 });
    queue.enqueueHpTween('u1', 50, 50);
    expect(queue.active().length).toBe(0);
  });

  it('death animations include a particle field', () => {
    let t = 0;
    const queue = createAnimationQueue({ now: () => t, random: () => 0.5 });
    queue.enqueueDeath('u1', { x: 2, y: 3 });
    const active = queue.active();
    expect(active[0]?.kind).toBe('death');
    if (active[0]?.kind === 'death') {
      expect(active[0].particles.length).toBeGreaterThanOrEqual(8);
    }
    t = DEATH_MS + 1;
    queue.tick();
    expect(queue.busy()).toBe(false);
  });

  it('createDeathParticles is deterministic for a fixed RNG', () => {
    const r1 = createDeathParticles(() => 0.5);
    const r2 = createDeathParticles(() => 0.5);
    expect(r1).toEqual(r2);
  });

  it('full ATTACK timeline: shake + flash + HP tween line up with the attack window', () => {
    let t = 0;
    const queue = createAnimationQueue({ now: () => t });
    queue.enqueueAttack('atk', 'tgt');
    queue.enqueueHpTween('tgt', 100, 60);
    queue.enqueueShake();
    queue.tick();
    expect(queue.busy()).toBe(true);

    // Mid-attack the flash is active and the HP tween is interpolating.
    t = ATTACK_MS / 2;
    queue.tick();
    expect(queue.flashIntensity('tgt')).toBeGreaterThan(0);

    // After the attack window the flash returns to 0 but blocking is over.
    t = ATTACK_MS + 5;
    queue.tick();
    expect(queue.flashIntensity('tgt')).toBe(0);
    expect(queue.busy()).toBe(false);
  });
});
