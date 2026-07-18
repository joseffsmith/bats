// @vitest-environment jsdom
//
// The `?debug=1` automation hook. We install it against a REAL emitter (so the
// stateChanged wiring is exercised for real) plus lightweight stubs for the
// renderer / input / animQueue / aiDriver, and assert the two behaviours the
// harness depends on: the applied-action history buffer caps at 500, and
// `idle()` is exactly `!animBusy() && !aiBusy()`.

import { describe, expect, it } from 'vitest';
import duelMap from '../src/data/maps/duel.json';
import { loadMap } from '../src/engine/data/loader';
import { createEmitter } from '../src/renderer/emitter';
import { installDebugHook } from '../src/renderer/debug-hook';
import type { CanvasRenderer } from '../src/renderer/canvas';
import type { InputController } from '../src/renderer/input';
import type { AnimationQueue } from '../src/renderer/animations';
import type { AIDriver } from '../src/renderer/ai-driver';
import type { Action } from '../src/engine/core/types';

function setup() {
  const emitter = createEmitter(loadMap(duelMap));
  // Renderer stub: only the coord-transform methods are reachable from the hook.
  const renderer = {
    tileToPixel: (c: { x: number; y: number }) => ({ x: c.x * 48, y: c.y * 48 }),
    getViewport: () => ({ tileSize: 48, width: 0, height: 0, dpr: 1, origin: { x: 0, y: 0 } }),
    pixelToTile: (x: number, y: number) => ({ x: Math.floor(x / 48), y: Math.floor(y / 48) }),
  } as unknown as CanvasRenderer;
  const input = {
    click: () => {},
    hover: () => {},
    cancel: () => {},
    getState: () => ({ kind: 'idle' }),
  } as unknown as InputController;
  // Mutable busy flags so tests can drive idle().
  const flags = { anim: false, ai: false };
  const animQueue = { busy: () => flags.anim } as unknown as AnimationQueue;
  const aiDriver = { busy: () => flags.ai } as unknown as AIDriver;
  const hook = installDebugHook({ emitter, renderer, input, animQueue, aiDriver });
  return { emitter, hook, flags };
}

describe('installDebugHook', () => {
  it('installs window.__bats with version 1', () => {
    const { hook } = setup();
    expect((globalThis as { __bats?: unknown }).__bats).toBe(hook);
    expect(hook.version).toBe(1);
  });

  it('records only applied actions (non-null) and caps history at 500', () => {
    const { emitter, hook } = setup();
    const applied: Action = { type: 'END_TURN' };
    const state = emitter.getState();
    // Overlay-only / rejected dispatches carry action:null and must be ignored.
    emitter.emit({ type: 'stateChanged', state, action: null });
    // Push 600 applied actions; the buffer should keep the last 500.
    for (let i = 0; i < 600; i++) {
      emitter.emit({ type: 'stateChanged', state, action: applied });
    }
    emitter.emit({ type: 'stateChanged', state, action: null });
    expect(hook.history).toHaveLength(500);
    expect(hook.history.every((a) => a.type === 'END_TURN')).toBe(true);
  });

  it('idle() reflects the animQueue + aiDriver busy state', () => {
    const { hook, flags } = setup();
    expect(hook.idle()).toBe(true);
    flags.anim = true;
    expect(hook.animBusy()).toBe(true);
    expect(hook.idle()).toBe(false);
    flags.anim = false;
    flags.ai = true;
    expect(hook.aiBusy()).toBe(true);
    expect(hook.idle()).toBe(false);
    flags.ai = false;
    expect(hook.idle()).toBe(true);
  });

  it('tileToScreen returns the tile centre in CSS px', () => {
    const { hook } = setup();
    // tile (1,2) → top-left (48,96) + half-tile (24) → centre (72,120).
    expect(hook.tileToScreen({ x: 1, y: 2 })).toEqual({ x: 72, y: 120 });
  });
});
