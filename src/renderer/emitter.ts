// Tiny pub-sub used by the renderer layer.
//
// The renderer reads state through a single emitter that holds the current
// GameState and exposes `dispatch(action)` as a thin wrapper around the engine
// reducer. After every dispatch (legal or not — the reducer is tolerant) the
// emitter re-fires `stateChanged` so canvas/HUD subscribers can redraw.
//
// Why not RxJS / Redux / Zustand? See PLAN.md: "Resist adding state-management
// libraries." This is enough.

import type { Action, GameState } from '../engine/core/types';
import { reduce } from '../engine/core/reducer';

export type EmitterEvent =
  | { type: 'stateChanged'; state: GameState; action: Action | null }
  | { type: 'animationStarted'; kind: string }
  | { type: 'animationEnded'; kind: string };

export type EmitterListener = (event: EmitterEvent) => void;

export type Emitter = {
  /** Subscribe to all events. Returns an unsubscribe function. */
  on(listener: EmitterListener): () => void;
  /** Manually emit an event (used by the animation system). */
  emit(event: EmitterEvent): void;
  /** Dispatch an action through the engine reducer. */
  dispatch(action: Action): GameState;
  /** Read the current state. */
  getState(): GameState;
  /** Replace the current state without going through the reducer (load/reset). */
  setState(state: GameState): void;
};

export function createEmitter(initialState: GameState): Emitter {
  let state = initialState;
  const listeners = new Set<EmitterListener>();

  function emit(event: EmitterEvent): void {
    // Snapshot listeners — a listener may unsubscribe during dispatch.
    for (const l of Array.from(listeners)) {
      try {
        l(event);
      } catch (err) {
        console.error('[emitter] listener threw', err);
      }
    }
  }

  return {
    on(listener: EmitterListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit,
    dispatch(action: Action): GameState {
      const next = reduce(state, action);
      const changed = next !== state;
      state = next;
      // Always emit so the renderer can clear stale highlights even if the
      // engine no-op'd (e.g. an illegal click). `action` is included so the
      // animation queue can react.
      emit({ type: 'stateChanged', state, action: changed ? action : null });
      return state;
    },
    getState(): GameState {
      return state;
    },
    setState(next: GameState): void {
      state = next;
      emit({ type: 'stateChanged', state, action: null });
    },
  };
}
