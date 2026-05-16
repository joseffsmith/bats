// DOM chrome around the canvas: mirrored player HUDs, centered turn indicator,
// bottom-left toolshelf (replay/save/load/sound), bottom-right AI controllers +
// end-turn cluster. All canvas top-bar / end-turn drawing was removed in
// favour of this module — see hud.ts (action/build menus remain on canvas as
// they're tile-anchored).
//
// The chrome subscribes to the emitter and re-renders on stateChanged.
// Interactive controls dispatch through emitter / aiDriver / audio as before.
//
// pointer-events on the root is `none` so canvas clicks pass through the void;
// individual interactive controls opt back in with `auto`.
//
// CHROME_TOP_HEIGHT / CHROME_BOTTOM_HEIGHT are exported so canvas.ts can
// reserve grid space.

import type { GameState, PlayerId } from '../engine/core/types';
import type { Emitter } from './emitter';
import type { AIDriver, AIChoice } from './ai-driver';
import { AI_CHOICES } from './ai-driver';
import type { AnimationQueue } from './animations';
import type { AudioModule } from './audio';
import { deserialize, downloadSave } from '../engine/save';
import { parseLog, replay } from '../engine/replay';
import { loadMap } from '../engine/data/loader';
import { MAPS, MAP_NAMES, mapLabel, resolveMapName } from './maps';
import type { MapName } from './maps';
import { log } from '../engine/core/logger';

export const CHROME_TOP_HEIGHT = 96;
export const CHROME_BOTTOM_HEIGHT = 96;

const PLAYER_NAMES: Record<PlayerId, string> = { 0: 'Vermilion', 1: 'Cobalt' };
const PLAYER_NUMERALS: Record<PlayerId, string> = { 0: 'I', 1: 'II' };

export type Chrome = {
  destroy(): void;
};

export type ChromeDeps = {
  parent: HTMLElement;
  emitter: Emitter;
  aiDriver: AIDriver;
  animQueue: AnimationQueue;
  audio: AudioModule;
};

export function createChrome(deps: ChromeDeps): Chrome {
  ensureStyle();

  const root = document.createElement('div');
  root.className = 'chrome-root';

  // ── Top chrome ────────────────────────────────────────────────────────────
  const top = document.createElement('header');
  top.className = 'chrome-top';

  const p1Panel = createPlayerPanel(0);
  const p2Panel = createPlayerPanel(1);
  const turn = createTurnIndicator();

  top.appendChild(p1Panel.root);
  top.appendChild(turn.root);
  top.appendChild(p2Panel.root);
  root.appendChild(top);

  // ── Bottom chrome ─────────────────────────────────────────────────────────
  const bottom = document.createElement('footer');
  bottom.className = 'chrome-bottom';

  const toolshelf = createToolshelf({
    emitter: deps.emitter,
    animQueue: deps.animQueue,
    audio: deps.audio,
  });
  const actions = createActions({
    emitter: deps.emitter,
    aiDriver: deps.aiDriver,
  });

  bottom.appendChild(toolshelf.root);
  bottom.appendChild(actions.root);
  root.appendChild(bottom);

  // Winner banner — a modal-style overlay that mounts when the game ends.
  // Lives in DOM (not canvas) so it can capture clicks even when the input
  // state machine has locked canvas events because `state.winner !== null`.
  const winner = createWinnerOverlay();
  root.appendChild(winner.root);

  deps.parent.appendChild(root);

  // ── State refresh ─────────────────────────────────────────────────────────
  function refresh(state: GameState): void {
    p1Panel.update(state);
    p2Panel.update(state);
    turn.update(state);
    actions.update(state);
    winner.update(state);
  }

  const unsub = deps.emitter.on((ev) => {
    if (ev.type === 'stateChanged') refresh(ev.state);
  });

  refresh(deps.emitter.getState());

  return {
    destroy(): void {
      unsub();
      root.remove();
    },
  };
}

// ─────────────────────────── Player panel ────────────────────────────────────

type PlayerPanel = {
  root: HTMLElement;
  update(state: GameState): void;
};

function createPlayerPanel(pid: PlayerId): PlayerPanel {
  const root = document.createElement('div');
  root.className = `player-panel p${pid + 1}`;

  const marker = document.createElement('div');
  marker.className = 'marker';
  marker.textContent = PLAYER_NUMERALS[pid];

  const meta = document.createElement('div');
  meta.className = 'meta';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = pid === 0 ? 'Player One' : 'Player Two';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = PLAYER_NAMES[pid];
  meta.appendChild(label);
  meta.appendChild(name);

  const stats = document.createElement('div');
  stats.className = 'stats';

  const fundsStat = createStat('Coffer');
  const unitsStat = createStat('Units');
  stats.appendChild(fundsStat.root);
  stats.appendChild(unitsStat.root);

  root.appendChild(marker);
  root.appendChild(meta);
  root.appendChild(stats);

  function update(state: GameState): void {
    const isActive = state.currentPlayer === pid && state.winner === null;
    root.classList.toggle('active', isActive);
    root.classList.toggle('inactive', !isActive);
    const funds = state.players[pid].funds;
    fundsStat.value.textContent = `$${funds.toLocaleString('en-US')}`;
    fundsStat.value.classList.toggle('muted', funds === 0);
    const count = Object.values(state.units).filter((u) => u.owner === pid).length;
    unitsStat.value.textContent = String(count);
    unitsStat.value.classList.toggle('muted', count === 0);
  }

  return { root, update };
}

function createStat(label: string): { root: HTMLElement; value: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'stat';
  const v = document.createElement('span');
  v.className = 'v';
  v.textContent = '—';
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = label;
  root.appendChild(v);
  root.appendChild(k);
  return { root, value: v };
}

// ─────────────────────────── Turn indicator ──────────────────────────────────

type TurnIndicator = {
  root: HTMLElement;
  update(state: GameState): void;
};

function createTurnIndicator(): TurnIndicator {
  const root = document.createElement('div');
  root.className = 'turn-indicator';

  const phase = document.createElement('span');
  phase.className = 'phase';
  phase.textContent = 'Movement';

  const turnN = document.createElement('span');
  turnN.className = 'turn-n';

  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const arrowText = document.createElement('span');
  arrowText.className = 'arrow-text';
  arrow.appendChild(dot);
  arrow.appendChild(arrowText);

  root.appendChild(phase);
  root.appendChild(turnN);
  root.appendChild(arrow);

  function update(state: GameState): void {
    turnN.innerHTML = `Turn <em>${String(state.turn).padStart(2, '0')}</em>`;
    if (state.winner !== null) {
      phase.textContent = 'Concluded';
      arrowText.textContent = `${PLAYER_NAMES[state.winner]} victorious`;
      root.dataset.player = String(state.winner);
    } else {
      phase.textContent = 'Movement';
      arrowText.textContent = `${PLAYER_NAMES[state.currentPlayer]} to act`;
      root.dataset.player = String(state.currentPlayer);
    }
  }

  return { root, update };
}

// ─────────────────────────── Toolshelf ───────────────────────────────────────

type ToolshelfDeps = {
  emitter: Emitter;
  animQueue: AnimationQueue;
  audio: AudioModule;
};

function createToolshelf(deps: ToolshelfDeps): { root: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'toolshelf';

  const replayBtn = makeTool('Replay', '⤺');
  const saveBtn = makeTool('Save', '◊');
  const loadBtn = makeTool('Load', '◈');
  const soundBtn = makeTool('Sound on', '♪');

  // File pickers (hidden, triggered programmatically).
  const loadFile = document.createElement('input');
  loadFile.type = 'file';
  loadFile.accept = 'application/json,.json';
  loadFile.style.display = 'none';

  // ── Wiring ────────────────────────────────────────────────────────────────
  replayBtn.addEventListener('click', () => {
    openReplayModal(deps);
  });

  saveBtn.addEventListener('click', () => {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      downloadSave(deps.emitter.getState(), `bats-save-${ts}.json`);
      flashTool(saveBtn, 'Saved');
      log('engine', 'save downloaded');
    } catch (err) {
      flashTool(saveBtn, 'Save failed', true);
      console.error(err);
    }
  });

  loadBtn.addEventListener('click', () => {
    loadFile.value = '';
    loadFile.click();
  });
  loadFile.addEventListener('change', () => {
    const file = loadFile.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (): void => {
      try {
        const state = deserialize(String(reader.result ?? ''));
        deps.emitter.setState(state);
        flashTool(loadBtn, 'Loaded');
        log('engine', 'save loaded', { turn: state.turn });
      } catch (err) {
        flashTool(loadBtn, 'Load failed', true);
        console.error(err);
      }
    };
    reader.onerror = (): void => flashTool(loadBtn, 'Read error', true);
    reader.readAsText(file);
  });

  const refreshSound = (): void => {
    const muted = deps.audio.isMuted();
    soundBtn.querySelector('.tool-label')!.textContent = muted ? 'Sound off' : 'Sound on';
    soundBtn.classList.toggle('off', muted);
  };
  refreshSound();
  soundBtn.addEventListener('click', () => {
    deps.audio.unlock();
    deps.audio.setMuted(!deps.audio.isMuted());
    refreshSound();
  });

  // Map picker — reloads the page with `?map=<name>` so we get a fresh state
  // through `main.ts` rather than trying to live-swap.
  const mapPicker = createMapPicker();
  // Fog toggle — reloads the page with `?fog=on|off` for the same reason
  // (live-swapping fog mid-game is meaningless when the AI was planning
  // omnisciently up to that point).
  const fogToggle = createFogToggle();

  root.appendChild(replayBtn);
  root.appendChild(makeDivider());
  root.appendChild(saveBtn);
  root.appendChild(loadBtn);
  root.appendChild(makeDivider());
  root.appendChild(soundBtn);
  root.appendChild(makeDivider());
  root.appendChild(mapPicker);
  root.appendChild(fogToggle);
  root.appendChild(loadFile);

  return { root };
}

function createFogToggle(): HTMLElement {
  const params = new URLSearchParams(window.location.search);
  const on = (params.get('fog') ?? 'off').toLowerCase();
  const isOn = on === 'on' || on === '1' || on === 'true';
  const btn = makeTool(isOn ? 'Fog on' : 'Fog off', '◐');
  btn.classList.toggle('off', !isOn);
  btn.addEventListener('click', () => {
    const url = new URL(window.location.href);
    url.searchParams.set('fog', isOn ? 'off' : 'on');
    window.location.assign(url.toString());
  });
  return btn;
}

function createMapPicker(): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'map-picker tool';
  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  glyph.textContent = '◰';
  const text = document.createElement('span');
  text.className = 'tool-label';
  text.textContent = 'Map';
  const sel = document.createElement('select');
  sel.className = 'map-select';
  const params = new URLSearchParams(window.location.search);
  const current = resolveMapName(params.get('map'));
  for (const name of MAP_NAMES) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = mapLabel(name);
    if (name === current) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    const next = sel.value as MapName;
    const url = new URL(window.location.href);
    url.searchParams.set('map', next);
    window.location.assign(url.toString());
  });
  // Prevent the wrapping `.tool` button from receiving the click & stealing
  // focus when the user just wants to open the dropdown.
  sel.addEventListener('click', (e) => e.stopPropagation());
  wrap.appendChild(glyph);
  wrap.appendChild(text);
  wrap.appendChild(sel);
  return wrap;
}

function makeTool(label: string, glyph: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tool';
  b.innerHTML = `<span class="glyph">${glyph}</span><span class="tool-label">${label}</span>`;
  return b;
}

function makeDivider(): HTMLElement {
  const d = document.createElement('span');
  d.className = 'divider';
  return d;
}

function flashTool(btn: HTMLElement, msg: string, err = false): void {
  const labelEl = btn.querySelector<HTMLElement>('.tool-label');
  if (!labelEl) return;
  const original = labelEl.textContent;
  labelEl.textContent = msg;
  btn.classList.toggle('flash', !err);
  btn.classList.toggle('flash-err', err);
  window.setTimeout(() => {
    if (labelEl.textContent === msg) {
      labelEl.textContent = original;
      btn.classList.remove('flash', 'flash-err');
    }
  }, 1800);
}

// ─────────────────────────── Actions (AI config + end turn) ──────────────────

type ActionsDeps = {
  emitter: Emitter;
  aiDriver: AIDriver;
};

type Actions = {
  root: HTMLElement;
  update(state: GameState): void;
};

function createActions(deps: ActionsDeps): Actions {
  const root = document.createElement('div');
  root.className = 'actions';

  // AI config strip.
  const aiConfig = document.createElement('div');
  aiConfig.className = 'ai-config';
  const aiLabel = document.createElement('span');
  aiLabel.className = 'ai-label';
  aiLabel.textContent = 'controllers';
  aiConfig.appendChild(aiLabel);

  for (const pid of [0, 1] as PlayerId[]) {
    const grp = document.createElement('span');
    grp.className = 'grp';
    const tag = document.createElement('span');
    tag.textContent = `P${pid + 1}`;
    const sel = document.createElement('select');
    for (const c of AI_CHOICES) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c[0]!.toUpperCase() + c.slice(1);
      sel.appendChild(opt);
    }
    sel.value = deps.aiDriver.getPlayerAI(pid);
    sel.addEventListener('change', () => {
      deps.aiDriver.setPlayerAI(pid, sel.value as AIChoice);
    });
    grp.appendChild(tag);
    grp.appendChild(sel);
    aiConfig.appendChild(grp);
  }

  // End-turn cluster.
  const cluster = document.createElement('div');
  cluster.className = 'end-turn-cluster';

  const turnMeta = document.createElement('div');
  turnMeta.className = 'turn-meta';
  const movesV = document.createElement('div');
  movesV.className = 'moves';
  const movesK = document.createElement('div');
  movesK.className = 'moves-k';
  movesK.textContent = 'Units to Act';
  turnMeta.appendChild(movesV);
  turnMeta.appendChild(movesK);

  const endTurn = document.createElement('button');
  endTurn.type = 'button';
  endTurn.className = 'end-turn';
  endTurn.dataset.action = 'end-turn';
  endTurn.innerHTML = 'End Turn <span class="kbd-ret">↵</span>';
  endTurn.addEventListener('click', () => {
    if (deps.emitter.getState().winner !== null) return;
    deps.emitter.dispatch({ type: 'END_TURN' });
  });

  cluster.appendChild(turnMeta);
  cluster.appendChild(endTurn);

  root.appendChild(aiConfig);
  root.appendChild(cluster);

  function update(state: GameState): void {
    const current = state.currentPlayer;
    const owned = Object.values(state.units).filter((u) => u.owner === current);
    const remaining = owned.filter((u) => !u.hasActed).length;
    movesV.innerHTML = `<em>${remaining}</em> / ${owned.length}`;
    cluster.dataset.player = String(current);
    const concluded = state.winner !== null;
    endTurn.disabled = concluded;
    endTurn.classList.toggle('disabled', concluded);
  }

  return { root, update };
}

// ─────────────────────────── Winner overlay ──────────────────────────────────

type WinnerOverlay = {
  root: HTMLElement;
  update(state: GameState): void;
};

function createWinnerOverlay(): WinnerOverlay {
  const root = document.createElement('div');
  root.className = 'winner-overlay';
  root.hidden = true;

  const dialog = document.createElement('div');
  dialog.className = 'winner-dialog';

  const eyebrow = document.createElement('div');
  eyebrow.className = 'winner-eyebrow';
  eyebrow.textContent = 'Match Concluded';

  const title = document.createElement('h2');
  title.className = 'winner-title';

  const subtitle = document.createElement('div');
  subtitle.className = 'winner-subtitle';

  const buttons = document.createElement('div');
  buttons.className = 'winner-buttons';

  const playAgain = makeTool('Play Again', '↻');
  playAgain.classList.add('primary');
  playAgain.addEventListener('click', () => {
    // Reload preserves the current `?map=` (and any other params), giving us
    // a fresh state via main.ts without juggling reducer reset paths.
    window.location.reload();
  });

  const dismiss = makeTool('Dismiss', '×');
  dismiss.addEventListener('click', () => {
    root.hidden = true;
  });

  buttons.appendChild(playAgain);
  buttons.appendChild(dismiss);

  dialog.appendChild(eyebrow);
  dialog.appendChild(title);
  dialog.appendChild(subtitle);
  dialog.appendChild(buttons);
  root.appendChild(dialog);

  function update(state: GameState): void {
    if (state.winner === null) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    root.dataset.player = String(state.winner);
    title.textContent = `${PLAYER_NAMES[state.winner]} victorious`;
    subtitle.textContent = `Player ${state.winner + 1} captured the field on turn ${state.turn}.`;
  }

  return { root, update };
}

// ─────────────────────────── Replay modal ────────────────────────────────────

function openReplayModal(deps: ToolshelfDeps): void {
  // Single-instance: dismiss any existing modal first.
  document.querySelector('.replay-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'replay-modal';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const dialog = document.createElement('div');
  dialog.className = 'replay-dialog';

  const header = document.createElement('div');
  header.className = 'replay-header';
  const title = document.createElement('h2');
  title.textContent = 'Replay Log';
  const closeBtn = makeTool('Close', '×');
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(title);
  header.appendChild(closeBtn);

  const fileRow = document.createElement('div');
  fileRow.className = 'replay-file-row';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.jsonl,application/jsonl,text/plain';
  fileInput.className = 'replay-file';
  fileRow.appendChild(fileInput);

  const textarea = document.createElement('textarea');
  textarea.className = 'replay-textarea';
  textarea.placeholder = 'Paste a match JSONL log here, or pick a file above.';

  const loadBtn = makeTool('Load', '◈');
  loadBtn.classList.add('primary');

  const status = document.createElement('div');
  status.className = 'replay-status';
  status.textContent = 'no log loaded';

  const controls = document.createElement('div');
  controls.className = 'replay-controls';
  const firstBtn = makeTool('|<<', '⏮');
  const prevBtn = makeTool('Prev', '◀');
  const playBtn = makeTool('Play', '▶');
  const nextBtn = makeTool('Next', '▶');
  const lastBtn = makeTool('|>>', '⏭');
  for (const b of [firstBtn, prevBtn, playBtn, nextBtn, lastBtn]) b.disabled = true;

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '0';
  slider.value = '0';
  slider.className = 'replay-slider';
  slider.disabled = true;

  controls.append(firstBtn, prevBtn, playBtn, nextBtn, lastBtn, slider);

  dialog.append(header, fileRow, textarea, loadBtn, controls, status);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // ── Replay state ──────────────────────────────────────────────────────────
  type Ctx = { states: GameState[]; frame: number };
  let ctx: Ctx | null = null;
  let playing = false;
  let timerId: ReturnType<typeof setInterval> | null = null;

  function gotoFrame(frame: number): void {
    if (!ctx) return;
    const clamped = Math.max(0, Math.min(ctx.states.length - 1, frame));
    ctx.frame = clamped;
    const state = ctx.states[clamped]!;
    deps.animQueue.clear();
    deps.emitter.setState(state);
    slider.value = String(clamped);
    status.textContent = `frame ${clamped} / ${ctx.states.length - 1} · turn ${state.turn} · p${state.currentPlayer + 1}`;
  }

  function stopPlayback(): void {
    playing = false;
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
    playBtn.querySelector('.tool-label')!.textContent = 'Play';
  }

  function startPlayback(): void {
    if (!ctx) return;
    if (ctx.frame >= ctx.states.length - 1) ctx.frame = 0;
    playing = true;
    playBtn.querySelector('.tool-label')!.textContent = 'Pause';
    timerId = setInterval(() => {
      if (!ctx) return;
      if (ctx.frame >= ctx.states.length - 1) {
        stopPlayback();
        return;
      }
      gotoFrame(ctx.frame + 1);
    }, 250);
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (): void => {
      textarea.value = String(reader.result ?? '');
    };
    reader.readAsText(file);
  });

  loadBtn.addEventListener('click', () => {
    try {
      const text = textarea.value.trim();
      if (!text) {
        status.textContent = 'paste a log or pick a file first';
        return;
      }
      const parsed = parseLog(text);
      const mapJson = (MAPS as Record<string, unknown>)[parsed.header.map];
      if (!mapJson) throw new Error(`unknown map "${parsed.header.map}"`);
      const initial = loadMap(mapJson);
      const result = replay(initial, parsed.actions);
      ctx = { states: result.states, frame: 0 };
      slider.disabled = false;
      slider.min = '0';
      slider.max = String(result.states.length - 1);
      slider.value = '0';
      for (const b of [firstBtn, prevBtn, playBtn, nextBtn, lastBtn]) b.disabled = false;
      gotoFrame(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      status.textContent = `load failed: ${msg}`;
      status.classList.add('error');
      window.setTimeout(() => status.classList.remove('error'), 2400);
    }
  });

  firstBtn.addEventListener('click', () => {
    stopPlayback();
    gotoFrame(0);
  });
  prevBtn.addEventListener('click', () => {
    stopPlayback();
    if (ctx) gotoFrame(ctx.frame - 1);
  });
  nextBtn.addEventListener('click', () => {
    stopPlayback();
    if (ctx) gotoFrame(ctx.frame + 1);
  });
  lastBtn.addEventListener('click', () => {
    stopPlayback();
    if (ctx) gotoFrame(ctx.states.length - 1);
  });
  playBtn.addEventListener('click', () => {
    if (playing) stopPlayback();
    else startPlayback();
  });
  slider.addEventListener('input', () => {
    stopPlayback();
    gotoFrame(Number(slider.value));
  });
}

// ─────────────────────────── Styles ──────────────────────────────────────────

let stylesInjected = false;

function ensureStyle(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.chrome-root {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 10;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
}

.chrome-top {
  position: absolute;
  top: 0; left: 0; right: 0;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: stretch;
  padding: 14px 22px 0;
  gap: 16px;
  animation: chrome-settle 0.7s 0.05s both cubic-bezier(.2,.7,.2,1);
}

.chrome-bottom {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: end;
  padding: 0 22px 18px;
  gap: 16px;
  animation: chrome-settle 0.7s 0.25s both cubic-bezier(.2,.7,.2,1);
}

@keyframes chrome-settle {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: translateY(0); }
}
.chrome-bottom { animation-name: chrome-settle-up; }
@keyframes chrome-settle-up {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ── Player panels ── */
.player-panel {
  background: var(--panel);
  border: 1px solid var(--rule);
  padding: 12px 18px;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 16px;
  position: relative;
  overflow: hidden;
  min-height: 70px;
  transition: opacity 0.2s ease;
}
.player-panel.p1 {
  border-left: 3px solid var(--p1);
  background: linear-gradient(90deg, var(--p1-glow) 0%, transparent 70%), var(--panel);
}
.player-panel.p2 {
  border-right: 3px solid var(--p2);
  background: linear-gradient(-90deg, var(--p2-glow) 0%, transparent 70%), var(--panel);
  direction: rtl;
}
.player-panel.p2 > * { direction: ltr; }
.player-panel.p2 .stats { flex-direction: row-reverse; }
.player-panel.p2 .stat { align-items: flex-end; }
.player-panel.p2 .meta { text-align: right; }
.player-panel.inactive { opacity: 0.62; }

.player-panel.active::after {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: var(--gold);
  animation: pp-pulse 2.6s ease-in-out infinite;
}
@keyframes pp-pulse {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 1; }
}

.marker {
  width: 40px; height: 40px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-family: 'Fraunces', serif;
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.06em;
  position: relative;
}
.marker::after {
  content: '';
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 1px solid currentColor;
  opacity: 0.32;
}
.p1 .marker { background: var(--p1); color: #2a0c0c; box-shadow: 0 0 16px var(--p1-glow); }
.p2 .marker { background: var(--p2); color: #0a1e2a; box-shadow: 0 0 16px var(--p2-glow); }

.meta { display: flex; flex-direction: column; gap: 3px; }
.meta .label {
  font-size: 9.5px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.meta .name {
  font-family: 'Fraunces', serif;
  font-weight: 500;
  font-size: 21px;
  line-height: 1;
  letter-spacing: -0.01em;
  color: var(--ink);
  font-variation-settings: 'SOFT' 60, 'opsz' 32;
}

.stats {
  display: flex;
  gap: 20px;
  align-items: baseline;
}
.stat { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; }
.stat .v {
  font-family: 'Fraunces', serif;
  font-feature-settings: 'lnum' 'tnum';
  font-weight: 500;
  font-size: 24px;
  line-height: 1;
  color: var(--gold);
  font-variation-settings: 'opsz' 48;
}
.stat .v.muted { color: var(--ink-dim); }
.stat .k {
  font-size: 9.5px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink-faint);
}

/* ── Turn indicator ── */
.turn-indicator {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 28px;
  border-left: 1px solid var(--rule);
  border-right: 1px solid var(--rule);
  background: linear-gradient(180deg, rgba(42,36,25,0.5), transparent);
  min-width: 200px;
}
.turn-indicator .phase {
  font-size: 9.5px;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--gold-dim);
}
.turn-indicator .turn-n {
  font-family: 'Fraunces', serif;
  font-weight: 400;
  font-size: 32px;
  line-height: 1;
  color: var(--ink);
  font-feature-settings: 'lnum';
  letter-spacing: -0.02em;
  font-variation-settings: 'opsz' 144, 'SOFT' 30;
}
.turn-indicator .turn-n em {
  font-style: italic;
  color: var(--gold);
  font-weight: 500;
}
.turn-indicator .arrow {
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 9.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.turn-indicator[data-player="0"] .arrow .dot {
  background: var(--p1);
  box-shadow: 0 0 8px var(--p1);
}
.turn-indicator[data-player="1"] .arrow .dot {
  background: var(--p2);
  box-shadow: 0 0 8px var(--p2);
}
.turn-indicator .arrow .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--gold);
}

/* ── Toolshelf ── */
.toolshelf {
  display: flex;
  gap: 6px;
  align-items: center;
  pointer-events: auto;
}
.tool {
  background: var(--panel);
  border: 1px solid var(--rule);
  color: var(--ink-dim);
  padding: 8px 13px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  transition: all 0.15s ease;
  pointer-events: auto;
}
.tool:hover {
  border-color: var(--gold-dim);
  color: var(--ink);
  background: var(--panel-2);
}
.tool:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.tool .glyph {
  font-family: 'Fraunces', serif;
  font-style: italic;
  color: var(--gold-dim);
  font-size: 14px;
  line-height: 0;
}
.tool.flash { color: var(--ink); border-color: var(--gold); }
.tool.flash-err { color: #ff8a8a; border-color: #b04040; }
.tool.off .glyph { color: var(--ink-faint); }

.divider {
  width: 1px;
  height: 20px;
  background: var(--rule);
  margin: 0 3px;
}

.map-picker { cursor: default; padding-right: 8px; }
.map-picker .map-select {
  background: transparent;
  border: 1px solid var(--rule);
  color: var(--ink);
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px;
  padding: 3px 6px;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  cursor: pointer;
  margin-left: 4px;
}

/* ── Actions cluster ── */
.actions {
  display: flex;
  flex-direction: column;
  align-items: end;
  gap: 10px;
}
.ai-config {
  display: flex;
  gap: 14px;
  align-items: center;
  font-size: 10px;
  color: var(--ink-faint);
  letter-spacing: 0.22em;
  text-transform: uppercase;
  background: var(--panel);
  border: 1px solid var(--rule);
  padding: 6px 13px;
  pointer-events: auto;
}
.ai-config .ai-label {
  font-family: 'Fraunces', serif;
  font-style: italic;
  text-transform: none;
  letter-spacing: 0;
  color: var(--gold-dim);
  font-size: 13px;
}
.ai-config select {
  background: transparent;
  border: 1px solid var(--rule);
  color: var(--ink);
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px;
  padding: 3px 8px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  cursor: pointer;
  pointer-events: auto;
}
.ai-config .grp { display: inline-flex; gap: 6px; align-items: center; }

.end-turn-cluster {
  display: flex;
  align-items: stretch;
  border: 1px solid var(--p1-dim);
  background: var(--panel);
  pointer-events: auto;
  transition: border-color 0.2s ease;
}
.end-turn-cluster[data-player="1"] { border-color: var(--p2-dim); }

.turn-meta {
  padding: 10px 16px;
  text-align: right;
  line-height: 1.2;
  border-right: 1px solid var(--rule);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
}
.turn-meta .moves {
  font-family: 'Fraunces', serif;
  font-feature-settings: 'lnum' 'tnum';
  font-size: 20px;
  color: var(--ink);
  font-weight: 500;
  line-height: 1;
}
.turn-meta .moves em { color: var(--gold); font-style: normal; }
.turn-meta .moves-k {
  font-size: 9.5px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink-faint);
}

.end-turn {
  background: linear-gradient(180deg, var(--p1) 0%, #b33636 100%);
  color: #fff;
  border: none;
  padding: 0 24px;
  font-family: 'Fraunces', serif;
  font-size: 18px;
  font-weight: 500;
  letter-spacing: 0.02em;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 12px;
  transition: filter 0.1s ease, background 0.2s ease;
  font-variation-settings: 'opsz' 48, 'SOFT' 40;
  position: relative;
  overflow: hidden;
  pointer-events: auto;
}
.end-turn-cluster[data-player="1"] .end-turn {
  background: linear-gradient(180deg, var(--p2) 0%, #2f6789 100%);
}
.end-turn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(255,255,255,0.12), transparent 50%);
  pointer-events: none;
}
.end-turn:hover { filter: brightness(1.08); }
.end-turn:active { filter: brightness(0.92); }
.end-turn:disabled, .end-turn.disabled {
  background: var(--panel-2);
  color: var(--ink-faint);
  cursor: not-allowed;
}
.end-turn .kbd-ret {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  background: rgba(0,0,0,0.28);
  padding: 3px 7px;
  border-radius: 2px;
  letter-spacing: 0;
  font-weight: 400;
}

/* ── Replay modal ── */
.replay-modal {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(0,0,0,0.7);
  display: grid;
  place-items: center;
  pointer-events: auto;
  font-family: 'IBM Plex Mono', monospace;
}
.replay-dialog {
  background: var(--panel);
  border: 1px solid var(--rule-strong);
  width: min(560px, calc(100vw - 40px));
  padding: 20px 22px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 30px 80px -20px rgba(0,0,0,0.7);
}
.replay-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.replay-header h2 {
  margin: 0;
  font-family: 'Fraunces', serif;
  font-weight: 500;
  font-size: 22px;
  color: var(--ink);
  font-variation-settings: 'opsz' 48;
}
.replay-file { font-family: inherit; color: var(--ink-dim); font-size: 11px; }
.replay-textarea {
  min-height: 100px;
  resize: vertical;
  font: 11px 'IBM Plex Mono', monospace;
  background: var(--bg);
  color: var(--ink);
  border: 1px solid var(--rule);
  padding: 8px;
}
.replay-controls {
  display: flex;
  gap: 4px;
  align-items: center;
}
.replay-slider {
  flex: 1;
  accent-color: var(--gold);
}
.replay-status {
  font-size: 11px;
  color: var(--ink-dim);
  min-height: 1.4em;
  letter-spacing: 0.04em;
}
.replay-status.error { color: #ff8a8a; }
.tool.primary {
  background: var(--panel-2);
  color: var(--ink);
  border-color: var(--gold-dim);
}
.tool.primary:hover {
  background: var(--gold-dim);
  color: #1a1410;
}

/* ── Winner overlay ── */
.winner-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: radial-gradient(ellipse at center, rgba(10,6,2,0.7), rgba(0,0,0,0.92));
  display: grid;
  place-items: center;
  pointer-events: auto;
  animation: winner-fade 0.5s ease both;
}
.winner-overlay[hidden] { display: none; }
@keyframes winner-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.winner-dialog {
  background: var(--panel);
  border: 1px solid var(--rule-strong);
  padding: 32px 44px 28px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 360px;
  box-shadow: 0 30px 80px -16px rgba(0,0,0,0.85);
  position: relative;
}
.winner-overlay[data-player="0"] .winner-dialog {
  border-top: 3px solid var(--p1);
  box-shadow: 0 30px 80px -16px rgba(0,0,0,0.85),
              0 0 60px -10px var(--p1-glow);
}
.winner-overlay[data-player="1"] .winner-dialog {
  border-top: 3px solid var(--p2);
  box-shadow: 0 30px 80px -16px rgba(0,0,0,0.85),
              0 0 60px -10px var(--p2-glow);
}
.winner-eyebrow {
  font-size: 10px;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--gold-dim);
  font-family: 'IBM Plex Mono', monospace;
}
.winner-title {
  margin: 0;
  font-family: 'Fraunces', serif;
  font-weight: 500;
  font-size: 32px;
  line-height: 1.1;
  color: var(--ink);
  font-variation-settings: 'opsz' 144, 'SOFT' 30;
}
.winner-overlay[data-player="0"] .winner-title { color: var(--p1); }
.winner-overlay[data-player="1"] .winner-title { color: var(--p2); }
.winner-subtitle {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11.5px;
  color: var(--ink-dim);
  letter-spacing: 0.06em;
  margin-bottom: 14px;
}
.winner-buttons {
  display: flex;
  gap: 10px;
  justify-content: center;
}
`;
  const style = document.createElement('style');
  style.dataset.bats = 'chrome';
  style.textContent = css;
  document.head.appendChild(style);
}
