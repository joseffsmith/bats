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
//
// ── Campaign entry points ───────────────────────────────────────────────────
//   ?campaign=menu   short-circuits (like ?editor=1) into the mission list — no
//                    engine, no board, just the screen.
//   ?campaign=1..5   boots the normal match with the mission's settings applied:
//                    its board, its fog decision, human at seat 0 vs the
//                    commander's persona at seat 1. After the shell mounts, the
//                    mission runtime takes over briefing → hints → debrief.
// Anything else in `?campaign=` (or a campaign.json that fails validation) logs
// a warning and falls through to a normal skirmish boot.

import { CAMPAIGN_MAP_NAMES, MAPS, resolveAnyMapName, resolveMapName } from './renderer/maps';
import type { AnyMapName, MapName } from './renderer/maps';
import { loadMap } from './engine/data/loader';
import { enableFogMemory } from './engine/systems/memory';
import { createEmitter } from './renderer/emitter';
import { createCanvasRenderer } from './renderer/canvas';
import { createInputController } from './renderer/input';
import { createMenus } from './renderer/menus';
import { createAnimationQueue } from './renderer/animations';
import { createAIDriver, AI_CHOICES, AI_PERSONA_CHOICES } from './renderer/ai-driver';
import type { AIChoice } from './renderer/ai-driver';
import { log, setLogEnabled } from './engine/core/logger';
import type { Coord, PlayerId } from './engine/core/types';
import { resolveMobileMode } from './renderer/mobile/mode';
import { createCamera } from './renderer/camera';
import { mountGestures } from './renderer/mobile/gestures';
import { createHudStrip } from './renderer/mobile/hud-strip';
import { createTray } from './renderer/mobile/tray';
import { createSpriteCache } from './renderer/sprites';
import { createTerrainCache } from './renderer/terrain';
import { createAudio } from './renderer/audio';
import { createChrome } from './renderer/chrome';
import { createHandoff } from './renderer/handoff';
import { runEditor } from './renderer/editor';
import { installDebugHook } from './renderer/debug-hook';
import campaignJson from './data/campaign.json';
import { loadCampaign } from './campaign/loader';
import type { Mission } from './campaign/types';
import { progressStore } from './campaign/progress';
import {
  buildSelectView,
  createCampaignNav,
  createCampaignRuntime,
  parseCampaignParam,
} from './campaign/controller';
import {
  createDesktopPresenter,
  createMobilePresenter,
  mountMissionSelect,
} from './campaign/screens';
import type { Tray } from './renderer/mobile/tray';
import { installReplayCapture } from './renderer/replay-capture';

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

type CampaignBoot = {
  missions: Mission[];
  /** `menu` for the mission list, or a validated 1-based mission number. */
  entry: number | 'menu';
};

/**
 * Resolve `?campaign=`. Returns null — and boots a normal match — for an absent
 * or malformed parameter, a mission number the campaign doesn't have, or a
 * campaign.json that fails validation.
 *
 * The two registries are passed explicitly rather than taking the loader's
 * defaults: a mission must sit on a CAMPAIGN board (never a skirmish one), and
 * its persona must be a name the AI driver can actually instantiate — which is
 * the narrower `AI_PERSONA_CHOICES`, not every persona in the data file.
 */
function resolveCampaignBoot(): CampaignBoot | null {
  const entry = parseCampaignParam(params.get('campaign'));
  if (entry === null) {
    if (params.get('campaign') !== null) {
      console.warn(
        `[campaign] ignoring ?campaign=${params.get('campaign')} — expected "menu" or a mission number`,
      );
    }
    return null;
  }
  let missions: Mission[];
  try {
    missions = loadCampaign(campaignJson, {
      mapNames: CAMPAIGN_MAP_NAMES,
      personaNames: AI_PERSONA_CHOICES,
    });
  } catch (err) {
    console.warn('[campaign] campaign.json failed validation — booting a normal match', err);
    return null;
  }
  if (entry !== 'menu' && !missions.some((m) => m.n === entry)) {
    console.warn(
      `[campaign] no mission ${entry} — the campaign has ${missions.length}; booting a normal match`,
    );
    return null;
  }
  return { missions, entry };
}

/** `?campaign=menu` — the mission list, mounted on its own with no game behind
 *  it (same shape as the `?editor=1` short-circuit). */
function runCampaignMenu(parent: HTMLElement, missions: Mission[]): void {
  parent.innerHTML = '';
  const nav = createCampaignNav();
  mountMissionSelect({
    parent,
    view: buildSelectView(missions, progressStore()),
    handlers: {
      onSelect: (n) => nav.goTo(n),
      // Way out of the menu: drop the param and reload into a skirmish.
      onExit: () => {
        const url = new URL(window.location.href);
        url.searchParams.delete('campaign');
        window.location.assign(url.toString());
      },
    },
    mode: resolveMobileMode(params) ? 'mobile' : 'desktop',
  });
  log('render', 'campaign menu mounted', { missions: missions.length });
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
  // Campaign entry points. `menu` never boots a game at all; a mission number
  // boots the ordinary match below with the mission's board / fog / opponent.
  const campaign = resolveCampaignBoot();
  if (campaign !== null && campaign.entry === 'menu') {
    runCampaignMenu(document.getElementById('app') ?? document.body, campaign.missions);
    return;
  }
  const mission: Mission | null =
    campaign !== null && campaign.entry !== 'menu'
      ? (campaign.missions.find((m) => m.n === campaign.entry) ?? null)
      : null;

  const canvas = setupCanvas();
  // Campaign boards resolve through the `Any` registry — `resolveMapName` is
  // the skirmish gate and deliberately rejects them (maps.ts).
  const mapName: AnyMapName =
    mission !== null
      ? (resolveAnyMapName(mission.map) ?? resolveMapName(params.get('map')))
      : resolveMapName(params.get('map'));
  // Per-map colour grade is keyed by skirmish map name only; campaign boards
  // simply go ungraded rather than teaching maps.ts about tints.
  const gradeName: MapName | undefined =
    mission === null ? (mapName as MapName) : undefined;
  // Fog is a mission-level decision. Pin the viewer to seat 0: the campaign is
  // always human-vs-AI, so without the override the board would flip to the
  // opponent's vision on their turn and hand the player free intel.
  const fogConfig = mission !== null
    ? { on: mission.fog, viewerOverride: 0 as PlayerId }
    : parseFogConfig();
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
  // and is the single switch for the whole mobile-first UI: the camera + gesture
  // board (Phase A), the select→stage→commit tap grammar (Phase B), and the HUD
  // strip + command tray that replace the desktop chrome/menus/handoff entirely
  // (Phase C). With it off the app takes the identical desktop path it always
  // has — the two UIs are mounted exclusively, never side by side.
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
    ...(gradeName !== undefined ? { mapName: gradeName } : {}),
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

  // Campaign missions are always human at seat 0 against the mission's
  // commander at seat 1 — `?p0=`/`?p1=` are ignored so a briefing can never
  // describe an opponent the board isn't running.
  const initialAI: Record<PlayerId, AIChoice> =
    mission !== null
      ? { 0: 'human', 1: mission.opponent.persona as AIChoice }
      : parseInitialAI();
  // `?seed=N` pins the AI driver's RNG so headless tests get reproducible AI
  // turns. Absent → the driver keeps its `Date.now()` default. Spread the key
  // in only when present (exactOptionalPropertyTypes forbids `seed: undefined`).
  const seedRaw = params.get('seed');
  const seedParsed = seedRaw !== null ? Number(seedRaw) : NaN;
  const seed = Number.isFinite(seedParsed) ? Math.trunc(seedParsed) : undefined;
  // Capture the live match as a replay log — installed before the AI driver
  // so its very first action is recorded. Finished games auto-POST to
  // /api/replays; the toolshelf "Copy log" tool exports the same JSONL.
  const replayCapture = installReplayCapture(emitter, {
    map: mapName,
    seed: seed ?? 0,
    fog: fogConfig.on,
    p0: initialAI[0],
    p1: initialAI[1],
  });

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
    // Mobile taps go through select → stage → commit (input.ts); desktop keeps
    // the click machine unchanged. Spread rather than passing `undefined` —
    // exactOptionalPropertyTypes treats those as different things.
    ...(mobileMode ? ({ grammar: 'mobile' } as const) : {}),
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

  // ── DOM shell ───────────────────────────────────────────────────────────────
  // Exactly one of the two shells mounts. They are not layered or feature-
  // detected against each other: desktop gets chrome + menus + fog handoff,
  // mobile gets the HUD strip + command tray, and neither knows the other
  // exists. Both report their measured heights into the SAME sink
  // (`renderer.setBoardInsets`, which forwards the band to the camera), so the
  // board reserves exactly the space its shell occupies either way.
  const appRoot = document.getElementById('app') ?? document.body;
  // Held so the campaign runtime below can drive the tray's objective / hint /
  // panel extension points on mobile. Null on desktop.
  let tray: Tray | null = null;
  if (mobileMode) {
    // Two independent measurements, one inset call. Seeded from the CSS
    // contract (44px strip) so the very first frame — before either observer
    // has ticked — already reserves a plausible band. The tray only ever
    // reports its BASELINE (idle) height — taller transient states overlay the
    // board rather than re-banding the camera (see tray.ts `reportInset`), so
    // the board never jumps when the bottom section reflows.
    let insetTop = 44;
    let insetBottom = 0;
    const applyInsets = (): void => {
      renderer.setBoardInsets(insetTop, insetBottom);
    };
    createHudStrip({
      parent: appRoot,
      emitter,
      aiDriver,
      ...(camera !== undefined ? { camera } : {}),
      onInsetsChange: (t) => {
        insetTop = t;
        applyInsets();
      },
    });
    tray = createTray({
      parent: appRoot,
      emitter,
      input,
      aiDriver,
      animQueue,
      audio,
      sprites,
      onInsetsChange: (b) => {
        insetBottom = b;
        applyInsets();
      },
    });
    applyInsets();
    log('render', 'mobile shell mounted', { muted: audio.isMuted() });
  } else {
    // Mount DOM chrome (player HUDs, turn indicator, toolshelf, end-turn cluster,
    // AI controllers). The canvas underneath shows the board + animations.
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
      replayCapture,
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
  }

  // ── Campaign runtime ────────────────────────────────────────────────────────
  // Mounted AFTER the shell so its presenter can sit on top of it: on mobile it
  // drives the tray's objective / hint / panel hooks (a presented panel beats
  // the tray's own match-over takeover by tray.ts's own ordering); on desktop it
  // owns a z-97 overlay that paints over chrome's winner dialog (z 90) rather
  // than stacking beside it, plus objective / hint pills.
  if (mission !== null) {
    const ui =
      tray !== null
        ? createMobilePresenter({ tray, parent: appRoot })
        : createDesktopPresenter({ parent: appRoot });
    createCampaignRuntime({
      mission,
      emitter,
      ui,
      total: campaign !== null ? campaign.missions.length : 5,
    });
    log('render', 'campaign mission mounted', {
      mission: mission.id,
      map: mission.map,
      opponent: mission.opponent.persona,
      fog: mission.fog,
    });
  }

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
    campaign: mission?.id ?? null,
  });
}

void main();
