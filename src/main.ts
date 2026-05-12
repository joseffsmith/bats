// Phase 3 + 4 entry point.
//
// Wires the engine + renderer + input + AI driver together for hot-seat play
// or AI-vs-AI demos on a single Canvas. The flow:
//   1. Load the `duel` map JSON via the engine loader.
//   2. Spin up a state emitter holding that initial state.
//   3. Mount a CanvasRenderer + animation queue + InputController + HUD.
//   4. Mount the AI driver. By default both players are 'human'; flip via
//      the HUD AI controls panel or `?p0=utility&p1=utility` URL params.
//
// The page is the game — the canvas fills the viewport.

import duelMap from './data/maps/duel.json';
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
import { mountSaveLoadPanel } from './renderer/save-load-ui';
import { mountReplayPanel } from './renderer/replay-ui';
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

function mountAIPanel(
  parent: HTMLElement,
  driver: ReturnType<typeof createAIDriver>,
): void {
  // Floating DOM panel in the top-right corner. Keeps canvas paint loop
  // unencumbered while still meeting the "HUD AI controls" requirement.
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position: fixed',
    'top: 8px',
    'right: 168px', // sit to the left of the canvas End-Turn area
    'z-index: 10',
    'background: rgba(20,20,28,0.92)',
    'color: #e6ecff',
    'border: 1px solid #3a3e50',
    'border-radius: 4px',
    'padding: 6px 10px',
    'font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'display: flex',
    'gap: 12px',
    'align-items: center',
  ].join(';');

  function row(label: string, pid: PlayerId): HTMLElement {
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display: flex; gap: 6px; align-items: center;';
    const span = document.createElement('span');
    span.textContent = label;
    span.style.cssText = 'opacity: 0.8;';
    const select = document.createElement('select');
    select.style.cssText =
      'background: #1a1d28; color: #e6ecff; border: 1px solid #3a3e50; padding: 2px 4px; font: inherit;';
    for (const c of AI_CHOICES) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c[0]!.toUpperCase() + c.slice(1);
      select.appendChild(opt);
    }
    select.value = driver.getPlayerAI(pid);
    select.addEventListener('change', () => {
      driver.setPlayerAI(pid, select.value as AIChoice);
    });
    wrap.appendChild(span);
    wrap.appendChild(select);
    return wrap;
  }

  const title = document.createElement('span');
  title.textContent = 'AI:';
  title.style.cssText = 'opacity: 0.6; font-weight: 600;';
  panel.appendChild(title);
  panel.appendChild(row('P1', 0));
  panel.appendChild(row('P2', 1));
  parent.appendChild(panel);
}

function mountMuteToggle(
  parent: HTMLElement,
  audio: ReturnType<typeof createAudio>,
): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  const refresh = (): void => {
    btn.textContent = audio.isMuted() ? '🔇 Sound off' : '🔊 Sound on';
  };
  refresh();
  btn.style.cssText = [
    'position: fixed',
    'bottom: 8px',
    'left: 8px',
    'z-index: 10',
    'background: #1a1d28',
    'color: #e6ecff',
    'border: 1px solid #3a3e50',
    'padding: 3px 8px',
    'font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'cursor: pointer',
    'border-radius: 3px',
  ].join(';');
  btn.addEventListener('click', () => {
    audio.unlock();
    audio.setMuted(!audio.isMuted());
    refresh();
  });
  parent.appendChild(btn);
  return btn;
}

function main(): void {
  // Editor mode short-circuits the normal play wiring.
  if (params.get('editor') === '1') {
    runEditor(document.getElementById('app') ?? document.body);
    return;
  }
  const canvas = setupCanvas();
  const initialState = loadMap(duelMap);
  const emitter = createEmitter(initialState);

  const sprites = createSpriteCache();
  const renderer = createCanvasRenderer(canvas, { sprites });
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
  });

  const input = createInputController(renderer, emitter, animQueue);
  const hud = createHud(renderer);

  // Mount AI control panel.
  const appRoot = document.getElementById('app') ?? document.body;
  mountAIPanel(appRoot, aiDriver);

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

  mountSaveLoadPanel(appRoot, emitter);
  mountReplayPanel(appRoot, emitter, animQueue);
  mountMuteToggle(appRoot, audio);
  log('render', 'audio mounted', { muted: audio.isMuted() });

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
    map: 'duel',
    units: Object.keys(initialState.units).length,
    p0: initialAI[0],
    p1: initialAI[1],
  });
}

main();
