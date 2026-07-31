// Entry point.
//
// Wires the engine + renderer + input + AI driver + DOM chrome together for
// hot-seat play or AI-vs-AI demos. The flow:
//   1. Load the `duel` map JSON via the engine loader.
//   2. Spin up a state emitter holding that initial state.
//   3. Mount the canvas renderer + animation queue + input controller.
//   4. Mount the AI driver. By default both players are 'human'; flip via the
//      bottom-right controllers strip or `?p0=utility&p1=utility` URL params.
//   5. Mount the DOM chrome (player HUDs, turn indicator, toolshelf, end-turn)
//      and the DOM action/build menus (menus.ts).
//
// The canvas fills the viewport; DOM chrome floats over it at top and bottom.

import { MAPS, resolveMapName } from './renderer/maps';
import { loadMap } from './engine/data/loader';
import { enableFogMemory } from './engine/systems/memory';
import { createEmitter } from './renderer/emitter';
import { createCanvasRenderer } from './renderer/canvas';
import { createInputController } from './renderer/input';
import { createMenus } from './renderer/menus';
import { createAnimationQueue } from './renderer/animations';
import { createAIDriver, AI_CHOICES } from './renderer/ai-driver';
import type { AIChoice } from './renderer/ai-driver';
import { log, setLogEnabled } from './engine/core/logger';
import type { Coord, PlayerId } from './engine/core/types';
import { resolveMobileMode } from './renderer/mobile/mode';
import { createCamera } from './renderer/camera';
import { mountGestures } from './renderer/mobile/gestures';
import { createSpriteCache } from './renderer/sprites';
import { createTerrainCache } from './renderer/terrain';
import { createAudio } from './renderer/audio';
import { createChrome } from './renderer/chrome';
import { createHandoff } from './renderer/handoff';
import { runEditor } from './renderer/editor';
import { installDebugHook } from './renderer/debug-hook';

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
  // Tag as the board canvas so the global full-viewport / absolute-position CSS
  // (index.html) applies here but NOT to the editor's own canvas.
  canvas.className = 'board';
  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = '';
    app.appendChild(canvas);
  } else {
    document.body.appendChild(canvas);
  }
  return canvas;
}

async function main(): Promise<void> {
  // Editor mode short-circuits the normal play wiring.
  if (params.get('editor') === '1') {
    runEditor(document.getElementById('app') ?? document.body);
    return;
  }
  // `?sheet=1` short-circuits into the sprite contact sheet — the art-review
  // deliverable (see scripts/sprite-sheet.ts). Dependency-light on purpose: it
  // only touches the sprite cache, no engine/input/AI wiring.
  if (params.get('sheet') === '1') {
    const { runSheet } = await import('./renderer/assets/pixel-art/sheet');
    runSheet(document.getElementById('app') ?? document.body);
    return;
  }
  const canvas = setupCanvas();
  const mapName = resolveMapName(params.get('map'));
  const fogConfig = parseFogConfig();
  // `?ambient=off` (or `=0`) freezes all continuous idle animation for byte-
  // stable visual-regression screenshots. The renderer honours the flag for its
  // own idle terms (unit bob, selection dash) and skips factory smoke; the
  // `performance.now` freeze below additionally halts terrain.ts's *internal*
  // time reads (water shimmer, tree sway), which the renderer can't reach.
  const ambientRaw = (params.get('ambient') ?? 'on').toLowerCase();
  const ambient = !(ambientRaw === 'off' || ambientRaw === '0');
  const baseState = loadMap(MAPS[mapName]);
  const initialState = fogConfig.on ? enableFogMemory(baseState) : baseState;
  const emitter = createEmitter(initialState);
  // Units and terrain are both generated in-repo now — createSpriteCache and
  // createTerrainCache bake the hand-authored pixel-art grids at startup, so
  // there's nothing to await (the async main() shell is kept for the editor /
  // sheet dynamic imports above).
  const sprites = createSpriteCache();
  const terrain = createTerrainCache();

  // Mobile mode is resolved ONCE here (`?mobile=1|0`, else `(pointer: coarse)`)
  // and is the single switch for the camera + gesture board. Everything it turns
  // on is additive: with it off, the renderer takes the identical desktop path
  // it always has. The desktop chrome/menus/handoff still mount in BOTH modes —
  // replacing them with the mobile HUD strip + verb tray is a later phase.
  const mobileMode = resolveMobileMode(params);
  const camera = mobileMode
    ? createCamera({
        getMapSize: () => {
          const s = emitter.getState();
          return { cols: s.map[0]?.length ?? 0, rows: s.map.length };
        },
        getViewSize: () => ({
          width: window.innerWidth || 1024,
          height: window.innerHeight || 768,
        }),
        // Boot centred on whoever is about to play. Read lazily (on the camera's
        // first frame) so it sees the settled state, not the pre-fog one.
        getInitialFocus: () => {
          const s = emitter.getState();
          return s.players[s.currentPlayer]?.hq ?? null;
        },
      })
    : undefined;

  const renderer = createCanvasRenderer(canvas, {
    sprites,
    terrain,
    fog: fogConfig,
    mapName,
    ambient,
    ...(camera !== undefined ? { camera } : {}),
  });
  renderer.resize();

  let rafId = 0;
  // `?slowmo=N` slows all anims by N× (and shifts performance.now in the same
  // ratio for renderers that read it directly). Useful for screenshotting
  // mid-flight effects.
  const slowmoRaw = params.get('slowmo');
  const slowmo = slowmoRaw ? Math.max(1, Math.min(20, Number(slowmoRaw) || 1)) : 1;
  if (slowmo > 1) {
    const origNow = performance.now.bind(performance);
    const t0 = origNow();
    performance.now = (): number => t0 + (origNow() - t0) / slowmo;
  }
  // Ambient off pins performance.now to a FIXED constant (not a load-time
  // reading, which would differ run-to-run) so every terrain frame — water,
  // trees — is identical across the golden-generate and golden-compare passes.
  // Safe here because ambient=off is only used for static screenshots, where
  // nothing is animating and no elapsed-time math needs to progress.
  if (!ambient) {
    performance.now = (): number => 1_000;
  }
  const animQueue = createAnimationQueue({
    onBusyChange: (busy) => {
      log('render', 'animation busy', { busy });
    },
  });

  const initialAI = parseInitialAI();
  // `?seed=N` pins the AI driver's RNG so headless tests get reproducible AI
  // turns. Absent → the driver keeps its `Date.now()` default. Spread the key
  // in only when present (exactOptionalPropertyTypes forbids `seed: undefined`).
  const seedRaw = params.get('seed');
  const seedParsed = seedRaw !== null ? Number(seedRaw) : NaN;
  const seed = Number.isFinite(seedParsed) ? Math.trunc(seedParsed) : undefined;
  const aiDriver = createAIDriver({
    emitter,
    animQueue,
    initial: initialAI,
    pauseMs: 250,
    fog: fogConfig.on,
    ...(seed !== undefined ? { seed } : {}),
  });

  // Assigned once the fog handoff module is mounted (after chrome). Reads false
  // until then. Folded into the Enter-to-end-turn predicate so the keyboard can't
  // end a turn while the pass-the-device scrim is up (canvas clicks are already
  // blocked natively by the scrim's pointer-events).
  let handoffActive = (): boolean => false;

  const input = createInputController(renderer, emitter, animQueue, {
    endTurnAllowed: () =>
      !aiDriver.inputLocked(emitter.getState()) &&
      !animQueue.busy() &&
      !handoffActive(),
  });

  if (camera) {
    // Drag-to-pan + pinch-to-zoom. Mounted AFTER the input controller so its
    // capture-phase touch listeners are the first to see a gesture; taps are
    // deliberately left alone and reach `input` as the browser's synthetic
    // click, exactly as they do today (see gestures.ts).
    mountGestures({ canvas, camera });

    // AI auto-follow. An off-screen AI turn on a phone is just the board sitting
    // still while funds change, so during an input-locked (AI) turn the camera
    // pans to wherever the action landed. Cosmetic only — it never touches the
    // engine, and a human turn is never moved out from under the player's thumb.
    emitter.on((ev) => {
      if (ev.type !== 'stateChanged' || ev.action === null) return;
      if (!aiDriver.inputLocked(ev.state)) return;
      const a = ev.action;
      let focus: Coord | null = null;
      if (a.type === 'MOVE') {
        focus = a.path[a.path.length - 1] ?? null;
      } else if (a.type === 'ATTACK') {
        // A killed target is already gone from the post-action state; fall back
        // to the attacker, which is on the same screenful of board.
        focus =
          ev.state.units[a.targetId]?.pos ?? ev.state.units[a.attackerId]?.pos ?? null;
      } else if (a.type === 'BUILD') {
        focus = a.at;
      }
      if (focus) camera.centerOn(focus, true);
    });
  }

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
    // Single source of truth for the board insets: the chrome measures its own
    // header/footer heights and the renderer reserves exactly that much space.
    onInsetsChange: (t, b) => {
      renderer.setBoardInsets(t, b);
    },
    // Floating Cancel chip → drop the current input selection/menu/target.
    onCancel: () => input.cancel(),
  });
  log('render', 'chrome mounted', { muted: audio.isMuted() });

  // Hot-seat fog handoff interstitial. Only meaningful with fog on, no fixed
  // viewer override, and both controllers human (read live — the dropdowns can
  // switch a controller mid-game). Drops an opaque pass-the-device scrim on each
  // END_TURN; wired here so the Enter predicate above can suppress while it's up.
  const handoff = createHandoff({
    parent: appRoot,
    emitter,
    fogOn: fogConfig.on && fogConfig.viewerOverride === null,
    bothHuman: () =>
      aiDriver.getPlayerAI(0) === 'human' && aiDriver.getPlayerAI(1) === 'human',
  });
  handoffActive = (): boolean => handoff.isActive();

  // DOM action/build menus (Phase 2.3). Mounted after chrome so they layer above
  // it; they read `input.getOverlay()` and re-render on emitter transitions.
  // `sprites` lets build entries show the current player's baked unit icon.
  createMenus({ parent: appRoot, emitter, input, renderer, sprites });

  // `?debug=1` installs the window.__bats automation hook (state read, synthetic
  // input, idle-await). Gated so ordinary hot-seat play carries no global. Must
  // run after the modules above exist — the hook only delegates to them.
  if (params.get('debug') === '1') {
    installDebugHook({
      emitter,
      renderer,
      input,
      animQueue,
      aiDriver,
      ...(camera !== undefined ? { camera } : {}),
    });
    log('render', 'debug hook installed');
  }

  // Wrap input.click so a clicked-on AI player has the input ignored. The
  // input controller doesn't know about the driver — we filter at the boundary.
  const originalClickHandlers = new Map<string, EventListener>();
  void originalClickHandlers; // reserved for future detach work

  function frame(): void {
    animQueue.tick();
    aiDriver.tick();
    // Always redraw — continuous render features (idle bob, animated
    // selection ring, water shimmer, tree sway, factory smoke) need a fresh
    // frame regardless of game-state changes. The renderer is fast enough.
    const state = emitter.getState();
    const overlay = input.getOverlay();
    renderer.draw(state, overlay, animQueue);
    rafId = window.requestAnimationFrame(frame);
  }

  window.addEventListener('resize', () => {
    renderer.resize();
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
    mobile: mobileMode,
  });
}

void main();
