// Phase 3 entry point.
//
// Wires the engine + renderer + input layers together for hot-seat play on a
// single Canvas. No AI yet — Phase 4 owns that. The flow:
//   1. Load the `duel` map JSON via the engine loader.
//   2. Spin up a state emitter holding that initial state.
//   3. Mount a CanvasRenderer + animation queue + InputController + HUD.
//   4. Subscribe a single redraw callback that paints map → hud each frame.
//
// The page is the game — the canvas fills the viewport.

import duelMap from './data/maps/duel.json';
import { loadMap } from './engine/data/loader';
import { createEmitter } from './renderer/emitter';
import { createCanvasRenderer } from './renderer/canvas';
import { createInputController } from './renderer/input';
import { createHud } from './renderer/hud';
import { createAnimationQueue } from './renderer/animations';
import { log, setLogEnabled } from './engine/core/logger';

// `?render-log=1` flips the render category on for click-by-click traces.
const params = new URLSearchParams(window.location.search);
if (params.get('render-log') === '1') {
  setLogEnabled('render', true);
}

function setupCanvas(): HTMLCanvasElement {
  const existing = document.querySelector('canvas');
  if (existing) {
    existing.remove(); // Phase 0's placeholder, if still present
  }
  const canvas = document.createElement('canvas');
  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = '';
    app.appendChild(canvas);
  } else {
    document.body.appendChild(canvas);
  }
  return canvas;
}

function main(): void {
  const canvas = setupCanvas();
  const initialState = loadMap(duelMap);
  const emitter = createEmitter(initialState);

  const renderer = createCanvasRenderer(canvas);
  renderer.resize();

  let dirty = true;
  let rafId = 0;
  const animQueue = createAnimationQueue({
    onTick: () => {
      dirty = true;
    },
    onBusyChange: (busy) => {
      log('render', 'animation busy', { busy });
    },
  });

  const input = createInputController(renderer, emitter, animQueue);
  const hud = createHud(renderer);

  function frame(): void {
    animQueue.tick();
    if (dirty || animQueue.busy()) {
      const state = emitter.getState();
      const overlay = input.getOverlay();
      renderer.draw(state, overlay, animQueue);
      hud.draw(state, overlay);
      dirty = false;
    }
    rafId = window.requestAnimationFrame(frame);
  }

  emitter.on(() => {
    dirty = true;
  });

  window.addEventListener('resize', () => {
    renderer.resize();
    dirty = true;
  });

  rafId = window.requestAnimationFrame(frame);

  // Wire up cleanup for HMR / Vite dev.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.cancelAnimationFrame(rafId);
    });
  }

  log('engine', 'phase 3 boot complete', {
    map: 'duel',
    units: Object.keys(initialState.units).length,
  });
}

main();
