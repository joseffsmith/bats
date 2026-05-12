// Replay panel: paste/load a JSONL log, step or auto-play through.
//
// UX:
//   - Hidden by default; a small "Replay" toggle in the corner opens it.
//   - Inside: file picker + textarea + step controls.
//   - On Load, we parse the JSONL, look up the map by name from the bundled
//     map registry, build the initial state, and stash a precomputed array
//     of intermediate states from `replay(initialState, actions)`. Then we
//     drive the emitter by setState-ing the appropriate frame.
//   - Step buttons: |<<  <  ▶/⏸  >  >>|, plus a scrub slider.
//
// Auto-play uses a setInterval timer. We disable input while playing — the
// underlying input.ts already respects animQueue.busy, but a hard guard is
// useful because the replay viewer is hostile to mid-frame interruption.

import { parseLog, replay } from '../engine/replay';
import type { GameState } from '../engine/core/types';
import { loadMap } from '../engine/data/loader';
import duelMap from '../data/maps/duel.json';
import crossroadsMap from '../data/maps/crossroads.json';
import islandHopMap from '../data/maps/island_hop.json';
import canyonMap from '../data/maps/canyon.json';
import type { Emitter } from './emitter';
import type { AnimationQueue } from './animations';
import { log } from '../engine/core/logger';

const MAPS: Record<string, unknown> = {
  duel: duelMap,
  crossroads: crossroadsMap,
  island_hop: islandHopMap,
  canyon: canyonMap,
};

export function mountReplayPanel(
  parent: HTMLElement,
  emitter: Emitter,
  animQueue: AnimationQueue,
): HTMLElement {
  const toggle = makeButton('Replay');
  toggle.style.cssText += ';position: fixed; bottom: 8px; right: 168px; z-index: 10;';
  parent.appendChild(toggle);

  const panel = document.createElement('div');
  panel.setAttribute('data-bats-panel', 'replay');
  panel.style.cssText = [
    'position: fixed',
    'right: 168px',
    'bottom: 48px',
    'z-index: 11',
    'background: rgba(20,20,28,0.95)',
    'color: #e6ecff',
    'border: 1px solid #3a3e50',
    'border-radius: 4px',
    'padding: 10px',
    'font: 12px -apple-system, BlinkMacSystemFont, sans-serif',
    'display: none',
    'flex-direction: column',
    'gap: 6px',
    'min-width: 360px',
  ].join(';');

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.jsonl,application/jsonl,text/plain';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Paste a match JSONL log here, or use the file picker.';
  textarea.style.cssText = 'min-height: 80px; font: 11px monospace; background: #14161e; color: #e6ecff; border: 1px solid #3a3e50; padding: 4px;';

  const loadBtn = makeButton('Load');
  const closeBtn = makeButton('Close');

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '0';
  slider.value = '0';
  slider.style.cssText = 'flex: 1;';
  slider.disabled = true;

  const status = document.createElement('div');
  status.style.cssText = 'opacity: 0.85; min-height: 1.4em;';
  status.textContent = 'no log loaded';

  const firstBtn = makeButton('|<<');
  const prevBtn = makeButton('<');
  const playBtn = makeButton('▶');
  const nextBtn = makeButton('>');
  const lastBtn = makeButton('>>|');

  for (const b of [firstBtn, prevBtn, playBtn, nextBtn, lastBtn]) b.disabled = true;

  const controlRow = document.createElement('div');
  controlRow.style.cssText = 'display: flex; gap: 6px; align-items: center;';
  controlRow.append(firstBtn, prevBtn, playBtn, nextBtn, lastBtn, slider);

  const topRow = document.createElement('div');
  topRow.style.cssText = 'display: flex; gap: 6px; align-items: center;';
  topRow.append(fileInput, loadBtn, closeBtn);

  panel.append(topRow, textarea, controlRow, status);
  parent.appendChild(panel);

  toggle.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  });
  closeBtn.addEventListener('click', () => {
    panel.style.display = 'none';
  });

  // ── Replay state ───────────────────────────────────────────────────────────
  type ReplayCtx = { states: GameState[]; frame: number };
  let ctx: ReplayCtx | null = null;
  let playing = false;
  let timerId: ReturnType<typeof setInterval> | null = null;

  function gotoFrame(frame: number): void {
    if (!ctx) return;
    const clamped = Math.max(0, Math.min(ctx.states.length - 1, frame));
    ctx.frame = clamped;
    const state = ctx.states[clamped]!;
    animQueue.clear();
    emitter.setState(state);
    slider.value = String(clamped);
    status.textContent = `frame ${clamped} / ${ctx.states.length - 1} — turn ${state.turn} player ${state.currentPlayer} winner=${state.winner === null ? 'none' : String(state.winner)}`;
    log('replay', 'frame set', { frame: clamped, turn: state.turn });
  }

  function stopPlayback(): void {
    playing = false;
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
    playBtn.textContent = '▶';
  }

  function startPlayback(): void {
    if (!ctx) return;
    if (ctx.frame >= ctx.states.length - 1) ctx.frame = 0;
    playing = true;
    playBtn.textContent = '⏸';
    timerId = setInterval(() => {
      if (!ctx) return;
      if (ctx.frame >= ctx.states.length - 1) {
        stopPlayback();
        return;
      }
      gotoFrame(ctx.frame + 1);
    }, 250);
  }

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
        status.textContent = 'paste a log or load a file first';
        return;
      }
      const parsed = parseLog(text);
      const mapJson = MAPS[parsed.header.map];
      if (!mapJson) {
        throw new Error(`unknown map "${parsed.header.map}" — no bundled copy`);
      }
      const initial = loadMap(mapJson);
      const result = replay(initial, parsed.actions);
      ctx = { states: result.states, frame: 0 };
      slider.disabled = false;
      slider.min = '0';
      slider.max = String(result.states.length - 1);
      slider.value = '0';
      for (const b of [firstBtn, prevBtn, playBtn, nextBtn, lastBtn]) b.disabled = false;
      gotoFrame(0);
      log('replay', 'log loaded', {
        map: parsed.header.map,
        actions: parsed.actions.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      status.textContent = `load failed: ${msg}`;
      status.style.color = '#ff8888';
      window.setTimeout(() => {
        status.style.color = '';
      }, 2400);
    }
  });

  return panel;
}

function makeButton(label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.style.cssText = [
    'background: #1a1d28',
    'color: #e6ecff',
    'border: 1px solid #3a3e50',
    'padding: 3px 8px',
    'font: inherit',
    'cursor: pointer',
    'border-radius: 3px',
  ].join(';');
  return b;
}
