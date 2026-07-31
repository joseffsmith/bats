// Hand-rolled touch gestures for the mobile board: drag-to-pan and pinch-to-zoom.
//
// Hand-rolled because the two library-shaped options are both wrong here. The
// browser's own pan/zoom (`touch-action: auto`) scrolls and scales the *page*,
// not the board, and would fight the canvas's DPR transform; a Pointer Events
// abstraction would need the same threshold/tap bookkeeping anyway. So: three
// listeners, ~120 lines, no dependency.
//
// ── Coexisting with input.ts (which this module may NOT edit) ───────────────
// The input controller binds `click` / `contextmenu` / `mousemove` on the same
// canvas. On a touch device a tap produces a browser-SYNTHESIZED `click`, and
// that synthetic click is exactly how a tap already reaches the input state
// machine today. This module therefore does not intercept, forward, or
// re-dispatch taps at all — it stays out of the way and lets the synthetic click
// happen. Its whole job on the tap path is the negative one:
//
//     a gesture that panned, pinched, or ever saw a second finger must NOT
//     become a tap.
//
// The mechanism is `preventDefault()` on `touchend`, which per the Touch Events
// spec suppresses the synthetic mouse events (mousedown/mouseup/click) for that
// gesture. Sub-threshold releases skip the preventDefault, so their click sails
// through to input.ts untouched — no coupling between the two modules, and
// nothing in input.ts had to change.
//
// The listeners are registered in the CAPTURE phase so this module always sees a
// touch before anything bubbling could, and are `passive: false` because a
// passive listener may not call `preventDefault`.
//
// ── Deliberately absent: double-tap-to-zoom ────────────────────────────────
// A double-tap zoom would have to swallow every first tap for ~300ms to find out
// whether a second one is coming, which is precisely the input latency the whole
// mobile pass exists to remove. Zoom is pinch (continuous) plus the overview
// toggle (discrete); a tap is always, immediately, a tap.

import type { Camera } from '../camera';

/** Movement (CSS px) a single touch must exceed before it becomes a pan rather
 *  than a tap. Below this, thumb tremor on a "stationary" tap is absorbed. */
const PAN_THRESHOLD_PX = 8;

/** Pinches below this start distance are treated as noise (two fingers landing
 *  almost on top of each other would divide by ~0 into an absurd scale). */
const MIN_PINCH_DIST_PX = 24;

export type GestureDeps = {
  canvas: HTMLCanvasElement;
  camera: Camera;
  /** Optional gate — gestures are ignored while this returns false. */
  enabled?: () => boolean;
};

/** Mount the gesture handlers. Returns an unmount function. */
export function mountGestures(deps: GestureDeps): () => void {
  const { canvas, camera } = deps;
  const enabled = deps.enabled ?? ((): boolean => true);

  // Kill the browser's own scroll/zoom on the board so our handlers own the
  // glass. index.html already sets this for `canvas.board`; setting it here too
  // means the gesture layer is correct wherever it's mounted (tests included)
  // rather than depending on a stylesheet it doesn't own.
  canvas.style.touchAction = 'none';

  type Mode = 'none' | 'maybe-tap' | 'pan' | 'pinch';
  let mode: Mode = 'none';
  /** Sticky for the whole gesture: once two fingers touched, this can never
   *  end as a tap, no matter how still the remaining finger is. */
  let sawTwoTouches = false;
  /** Last single-touch position, for the incremental pan delta. */
  let lastX = 0;
  let lastY = 0;
  /** Where the single touch started, for the threshold test. */
  let startX = 0;
  let startY = 0;

  /**
   * Pinch snapshot, taken when the second finger lands. Every subsequent move
   * is computed against the SNAPSHOT rather than the previous frame, so
   * floating-point error and clamp asymmetry can't accumulate over a long pinch
   * — the transform is a pure function of "where the fingers are now".
   */
  let pinchDist0 = 0;
  let pinchMid0 = { x: 0, y: 0 };
  let pinchTs0 = 1;
  /** World point (tile units) under the pinch midpoint at snapshot time. */
  let pinchWorld0 = { x: 0, y: 0 };

  function localPoint(t: Touch): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }

  function midpoint(a: Touch, b: Touch): { x: number; y: number } {
    const pa = localPoint(a);
    const pb = localPoint(b);
    return { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
  }

  function distance(a: Touch, b: Touch): number {
    const pa = localPoint(a);
    const pb = localPoint(b);
    return Math.hypot(pb.x - pa.x, pb.y - pa.y);
  }

  function snapshotPinch(a: Touch, b: Touch): void {
    pinchDist0 = Math.max(MIN_PINCH_DIST_PX, distance(a, b));
    pinchMid0 = midpoint(a, b);
    pinchTs0 = camera.tileSize();
    const o = camera.origin();
    pinchWorld0 = {
      x: (pinchMid0.x - o.x) / pinchTs0,
      y: (pinchMid0.y - o.y) / pinchTs0,
    };
  }

  function reset(): void {
    mode = 'none';
    sawTwoTouches = false;
  }

  function onTouchStart(e: TouchEvent): void {
    if (!enabled()) return;
    if (e.touches.length >= 2) {
      const a = e.touches[0];
      const b = e.touches[1];
      if (!a || !b) return;
      sawTwoTouches = true;
      mode = 'pinch';
      snapshotPinch(a, b);
      // Two fingers are unambiguously a gesture, never a tap — safe to swallow.
      e.preventDefault();
      return;
    }
    const t = e.touches[0];
    if (!t) return;
    const p = localPoint(t);
    startX = p.x;
    startY = p.y;
    lastX = p.x;
    lastY = p.y;
    // NOT preventDefault: a single touch is still a candidate tap, and
    // preventing the default here would suppress the synthetic click that
    // carries that tap to input.ts.
    mode = 'maybe-tap';
  }

  function onTouchMove(e: TouchEvent): void {
    if (!enabled() || mode === 'none') return;

    if (mode === 'pinch') {
      const a = e.touches[0];
      const b = e.touches[1];
      if (!a || !b) return;
      const dist = Math.max(1, distance(a, b));
      const mid = midpoint(a, b);
      // Zoom by the finger-spread ratio, then place the origin so the world
      // point that was under the fingers at snapshot time is under them now.
      // Recomputing from the snapshot (not incrementally) also makes a
      // two-finger drag fall out for free: the midpoint moves, so the board does.
      camera.setZoom((pinchTs0 * dist) / pinchDist0, pinchMid0);
      const ts = camera.tileSize();
      const want = {
        x: mid.x - pinchWorld0.x * ts,
        y: mid.y - pinchWorld0.y * ts,
      };
      const cur = camera.origin();
      camera.panBy(want.x - cur.x, want.y - cur.y);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const t = e.touches[0];
    if (!t) return;
    const p = localPoint(t);

    if (mode === 'maybe-tap') {
      if (Math.hypot(p.x - startX, p.y - startY) <= PAN_THRESHOLD_PX) return;
      mode = 'pan';
    }

    camera.panBy(p.x - lastX, p.y - lastY);
    lastX = p.x;
    lastY = p.y;
    // Only now do we claim the gesture. Suppressing the default from here on
    // also tells the browser this was not a tap.
    e.preventDefault();
    e.stopPropagation();
  }

  function onTouchEnd(e: TouchEvent): void {
    const wasGesture = mode === 'pan' || mode === 'pinch' || sawTwoTouches;
    if (mode === 'pinch') {
      // Fingers off the glass → snap the tile size back to an integer so the
      // renderer's 0.5px hairlines land on real pixels again.
      camera.settle();
    }
    if (wasGesture) {
      // THE tap suppressor. Cancels the synthetic mouse events for this
      // gesture, so a pan/pinch can never arrive at input.ts as a board click.
      e.preventDefault();
      e.stopPropagation();
    }
    if (e.touches.length === 0) {
      reset();
      return;
    }
    if (e.touches.length === 1) {
      // Dropped from a pinch to one finger: keep panning with the survivor, but
      // `sawTwoTouches` stays set so the release still can't become a tap.
      const t = e.touches[0];
      if (!t) return;
      const p = localPoint(t);
      startX = p.x;
      startY = p.y;
      lastX = p.x;
      lastY = p.y;
      mode = 'pan';
      return;
    }
    // Three-plus fingers down to two: re-snapshot so the pinch stays anchored.
    const a = e.touches[0];
    const b = e.touches[1];
    if (a && b) {
      mode = 'pinch';
      snapshotPinch(a, b);
    }
  }

  function onTouchCancel(e: TouchEvent): void {
    if (mode === 'pinch') camera.settle();
    if (mode === 'pan' || mode === 'pinch' || sawTwoTouches) e.preventDefault();
    reset();
  }

  const opts: AddEventListenerOptions = { passive: false, capture: true };
  canvas.addEventListener('touchstart', onTouchStart, opts);
  canvas.addEventListener('touchmove', onTouchMove, opts);
  canvas.addEventListener('touchend', onTouchEnd, opts);
  canvas.addEventListener('touchcancel', onTouchCancel, opts);

  return (): void => {
    canvas.removeEventListener('touchstart', onTouchStart, opts);
    canvas.removeEventListener('touchmove', onTouchMove, opts);
    canvas.removeEventListener('touchend', onTouchEnd, opts);
    canvas.removeEventListener('touchcancel', onTouchCancel, opts);
  };
}
