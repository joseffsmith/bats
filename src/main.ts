// Entry point.
//
// Wires the engine + renderer + input + AI driver + DOM chrome together for
// hot-seat play or AI-vs-AI demos. The flow:
//   1. Load the `duel` map JSON via the engine loader.
//   2. Spin up a state emitter holding that initial state.
//   3. Mount the canvas renderer + animation queue + input controller + canvas
//      hud (tile-anchored popovers).
//   4. Mount the AI driver. By default both players are 'human'; flip via the
//      bottom-right controllers strip or `?p0=utility&p1=utility` URL params.
//   5. Mount the DOM chrome (player HUDs, turn indicator, toolshelf, end-turn).
//
// The canvas fills the viewport; DOM chrome floats over it at top and bottom.

import { MAPS, resolveMapName } from './renderer/maps';
import { loadMap } from './engine/data/loader';
import { createEmitter } from './renderer/emitter';
import { createCanvasRenderer } from './renderer/canvas';
import { createInputController } from './renderer/input';
import { createHud } from './renderer/hud';
import { createAnimationQueue } from './renderer/animations';
import { createAIDriver, AI_CHOICES } from './renderer/ai-driver';
import type { AIChoice } from './renderer/ai-driver';
import { log, setLogEnabled } from './engine/core/logger';
import type { PlayerId } from './engine/core/types';
import { createSpriteCache } from './renderer/sprites';
import { createAudio } from './renderer/audio';
import { createChrome } from './renderer/chrome';
import { runEditor } from './renderer/editor';

// `?render-log=1` flips the render category on for click-by-click traces.
// `?ai-trace=1` enables the very chatty per-candidate AI score log.
const params = new URLSearchParams(window.location.search);
if (params.get('render-log') === '1') {
  setLogEnabled('render', true);
}
if (params.get('ai-trace') === '1') {
  setLogEnabled('ai-trace', true);
}

function parseInitialAI(): Record<PlayerId, AIChoice> {
  const out: Record<PlayerId, AIChoice> = { 0: 'human', 1: 'human' };
  for (const [pid, key] of [[0, 'p0'], [1, 'p1']] as Array<[PlayerId, string]>) {
    const raw = params.get(key);
    if (raw && (AI_CHOICES as readonly string[]).includes(raw)) {
      out[pid] = raw as AIChoice;
    }
  }
  return out;
}

function parseFogConfig(): { on: boolean; viewerOverride: PlayerId | null } {
  const raw = (params.get('fog') ?? 'off').toLowerCase();
  const on = raw === 'on' || raw === '1' || raw === 'true';
  const view = params.get('view');
  let viewerOverride: PlayerId | null = null;
  if (view === 'p0' || view === '0') viewerOverride = 0;
  else if (view === 'p1' || view === '1') viewerOverride = 1;
  return { on, viewerOverride };
}

function setupCanvas(): HTMLCanvasElement {
  const existing = document.querySelector('canvas');
  if (existing) existing.remove();
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
  // Editor mode short-circuits the normal play wiring.
  if (params.get('editor') === '1') {
    runEditor(document.getElementById('app') ?? document.body);
    return;
  }
  const canvas = setupCanvas();
  const mapName = resolveMapName(params.get('map'));
  const initialState = loadMap(MAPS[mapName]);
  const emitter = createEmitter(initialState);

  const fogConfig = parseFogConfig();
  const sprites = createSpriteCache();
  const renderer = createCanvasRenderer(canvas, { sprites, fog: fogConfig });
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

  const initialAI = parseInitialAI();
  const aiDriver = createAIDriver({
    emitter,
    animQueue,
    initial: initialAI,
    pauseMs: 250,
    fog: fogConfig.on,
  });

  const input = createInputController(renderer, emitter, animQueue);
  const hud = createHud(renderer);

  // Audio: default muted (so we don't autoplay). The audio module gates its
  // own context init on first canvas click so browsers don't reject it.
  const audio = createAudio({
    initiallyMuted: params.get('sound') !== '1',
  });
  emitter.on((ev) => {
    if (ev.type !== 'stateChanged' || ev.action === null) return;
    audio.onAction(ev.action, ev.state);
  });
  canvas.addEventListener('click', () => audio.unlock(), { once: true });

  // Mount DOM chrome (player HUDs, turn indicator, toolshelf, end-turn cluster,
  // AI controllers). The canvas underneath shows the board + animations.
  const appRoot = document.getElementById('app') ?? document.body;
  createChrome({
    parent: appRoot,
    emitter,
    aiDriver,
    animQueue,
    audio,
  });
  log('render', 'chrome mounted', { muted: audio.isMuted() });

  // Wrap input.click so a clicked-on AI player has the input ignored. The
  // input controller doesn't know about the driver — we filter at the boundary.
  const originalClickHandlers = new Map<string, EventListener>();
  void originalClickHandlers; // reserved for future detach work

  function frame(): void {
    animQueue.tick();
    aiDriver.tick();
    if (dirty || animQueue.busy() || aiDriver.busy()) {
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

  // Disable canvas clicks when the current player is AI-controlled. We
  // attach a capture-phase listener that intercepts events before the
  // input controller sees them.
  canvas.addEventListener(
    'click',
    (e) => {
      if (aiDriver.inputLocked(emitter.getState())) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    },
    true, // capture phase
  );
  canvas.addEventListener(
    'contextmenu',
    (e) => {
      if (aiDriver.inputLocked(emitter.getState())) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    },
    true,
  );

  rafId = window.requestAnimationFrame(frame);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.cancelAnimationFrame(rafId);
    });
  }

  log('engine', 'phase 4 boot complete', {
    map: mapName,
    units: Object.keys(initialState.units).length,
    p0: initialAI[0],
    p1: initialAI[1],
  });
}

main();
