// Mobile-mode resolver.
//
// One question, one answer, resolved ONCE at boot (main.ts) so nothing
// downstream has to re-ask: is this session running the mobile board — a
// full-bleed, camera-driven, pinch-and-pan canvas — or the classic desktop
// framed board?
//
// Resolution order:
//   1. `?mobile=1` → forced on   (the shoot/e2e harnesses and manual testing)
//   2. `?mobile=0` → forced off  (escape hatch on a real phone)
//   3. otherwise   → `(pointer: coarse)` media query, i.e. "the primary
//      pointing device is a finger". Same signal input.ts already uses for its
//      two-tap attack confirm, so the two stay in lockstep by construction.
//
// Defensive about `window`/`matchMedia` so the module is importable (and
// testable) under the node + jsdom test environments.

/** True iff this session should run the mobile (camera + gestures) board. */
export function resolveMobileMode(params: URLSearchParams): boolean {
  const raw = params.get('mobile');
  if (raw === '1') return true;
  if (raw === '0') return false;
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}
