// Easing functions used by the Phase 6 animation polish layer.
//
// Pure math, no DOM. Both functions are clamped at the input boundaries so the
// renderer can call them with a slightly out-of-range `t` (e.g. due to
// floating-point drift on the last animation tick) without producing wild
// values.

/** Cubic ease-in-out — slow start, fast middle, slow end. Used for unit moves. */
export function easeInOutCubic(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * easeOutBack — overshoots past 1 then settles. Used for attack flashes so the
 * defender's flash "snaps" into place rather than fading linearly.
 *
 * The classic Penner constant `c1 = 1.70158`. The function exceeds 1 briefly
 * for t in roughly (0.55, 1.0); the caller should drive a `[0..1]` interpolant
 * that the renderer can interpret as e.g. flash intensity.
 */
export function easeOutBack(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/** Plain linear interpolation, exported for documentation symmetry. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
