// Mobile HUD strip — the 44px status bar pinned above the full-bleed board.
//
// This is the mobile counterpart to the desktop `chrome-top` (two mirrored
// player panels + a centred turn indicator). A phone has neither the width nor
// the attention budget for that, so the strip answers exactly four questions,
// left to right:
//
//   whose turn is it   → a skewed faction ribbon ("VERMILION TO ACT"), recoloured
//                        through `data-player` so the answer is legible as a
//                        block of colour before a single glyph is read;
//   how long have we been at this
//                      → the AW-style Day counter (Day = ⌈turn/2⌉ — the engine
//                        counts plies, the player counts days);
//   what can I spend    → the CURRENT player's funds only. The opponent's coffer
//                        is desktop trivia; on a phone it is a column of pixels
//                        that pushes the number that matters off the edge;
//   where am I          → the overview button, which flips the camera between the
//                        tactical zoom and the whole-map fit.
//
// Two structural contracts it shares with chrome.ts, deliberately:
//   - `ensureStyle()` injects the stylesheet exactly once, module-scoped;
//   - the root is `pointer-events: none` and only real controls opt back in —
//     except the bar itself, which is opaque and sits over a board that can be
//     panned underneath it, so a tap on the bar must NOT fall through to a tile.
//
// The strip measures its own height through a ResizeObserver and reports it via
// `onInsetsChange`. main.ts forwards that to `renderer.setBoardInsets`, which in
// turn hands the camera its band (canvas.ts). One measurement, one source of
// truth, no hard-coded 44 anywhere but the CSS.

import type { GameState, PlayerId } from '../../engine/core/types';
import type { Emitter } from '../emitter';
import type { AIDriver } from '../ai-driver';
import type { Camera } from '../camera';

/** Faction names. Same table as chrome.ts — the two surfaces are never mounted
 *  together, so this is a copy of the *value*, not a shared mutable. */
const PLAYER_NAMES: Record<PlayerId, string> = { 0: 'Vermilion', 1: 'Cobalt' };

/** Player-facing "Day" from the engine's ply counter (see chrome.ts). */
function dayOf(turn: number): number {
  return Math.ceil(turn / 2);
}

export type HudStrip = {
  destroy(): void;
};

export type HudStripDeps = {
  parent: HTMLElement;
  emitter: Emitter;
  /** Drives the subdued treatment while an AI holds the turn. */
  aiDriver: AIDriver;
  /** Mobile board camera. The overview button is omitted without one. */
  camera?: Camera;
  /** Reports the measured strip height (CSS px) whenever it changes. Fires once
   *  on mount, even if ResizeObserver is unavailable (jsdom). */
  onInsetsChange?: (top: number) => void;
};

export function createHudStrip(deps: HudStripDeps): HudStrip {
  ensureStyle();

  const root = document.createElement('div');
  root.className = 'mhud-root';

  const bar = document.createElement('header');
  bar.className = 'mhud';

  // ── Faction ribbon ─────────────────────────────────────────────────────────
  const ribbon = document.createElement('div');
  ribbon.className = 'mhud-ribbon';
  ribbon.dataset.hudRibbon = '';
  const pulse = document.createElement('span');
  pulse.className = 'mhud-pulse';
  const ribbonText = document.createElement('span');
  ribbonText.className = 'mhud-ribbon-text';
  ribbon.append(pulse, ribbonText);

  // ── Right cluster: day · funds · overview ──────────────────────────────────
  const right = document.createElement('div');
  right.className = 'mhud-right';

  const day = document.createElement('span');
  day.className = 'mhud-day';
  day.dataset.hudDay = '';

  const funds = document.createElement('span');
  funds.className = 'mhud-funds';
  funds.dataset.hudFunds = '';

  right.append(day, funds);

  let overview: HTMLButtonElement | null = null;
  if (deps.camera) {
    const camera = deps.camera;
    overview = document.createElement('button');
    overview.type = 'button';
    overview.className = 'mhud-overview';
    overview.dataset.action = 'overview';
    overview.setAttribute('aria-label', 'Toggle map overview');
    overview.textContent = '▣';
    overview.addEventListener('click', () => {
      camera.toggleOverview();
      syncOverview();
    });
    right.appendChild(overview);
  }

  bar.append(ribbon, right);
  root.appendChild(bar);
  deps.parent.appendChild(root);

  function syncOverview(): void {
    if (!overview || !deps.camera) return;
    const on = deps.camera.isOverview();
    overview.classList.toggle('on', on);
    overview.setAttribute('aria-pressed', String(on));
  }

  // ── State refresh ──────────────────────────────────────────────────────────
  function refresh(state: GameState): void {
    const concluded = state.winner !== null;
    const shown: PlayerId = concluded ? state.winner! : state.currentPlayer;
    bar.dataset.player = String(shown);
    ribbonText.textContent = concluded
      ? `${PLAYER_NAMES[shown]} victorious`
      : `${PLAYER_NAMES[shown]} to act`;

    day.textContent = `Day ${String(dayOf(state.turn)).padStart(2, '0')}`;
    funds.textContent = `◈ $${state.players[shown].funds.toLocaleString('en-US')}`;

    // Subdued while the AI is thinking: the strip is still readable but visibly
    // not addressed to the player, so nothing on it invites a tap mid-plan.
    const ai = !concluded && deps.aiDriver.inputLocked(state);
    if (ai) bar.dataset.ai = '1';
    else delete bar.dataset.ai;
    syncOverview();
  }

  const unsub = deps.emitter.on((ev) => {
    if (ev.type === 'stateChanged') refresh(ev.state);
  });
  refresh(deps.emitter.getState());

  // ── Measured board inset ───────────────────────────────────────────────────
  let lastTop = -1;
  function reportInset(): void {
    if (!deps.onInsetsChange) return;
    const t = Math.round(bar.offsetHeight);
    if (t === lastTop) return;
    lastTop = t;
    deps.onInsetsChange(t);
  }
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => reportInset());
    observer.observe(bar);
  }
  reportInset();

  return {
    destroy(): void {
      unsub();
      observer?.disconnect();
      root.remove();
    },
  };
}

// ─────────────────────────── Styles ──────────────────────────────────────────

let stylesInjected = false;

function ensureStyle(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.mhud-root {
  position: fixed;
  top: 0; left: 0; right: 0;
  pointer-events: none;
  /* Below the tray (15) — they never overlap, but the tray's tools sheet may
     rise past the top of the tray and should win. */
  z-index: 12;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
}

.mhud {
  /* The 44px contract: border-box, so the 2px accent rule is INSIDE the 44 and
     the strip measures exactly 44px (plus whatever notch the device reserves,
     which is added on top rather than eaten out of the bar). */
  box-sizing: border-box;
  height: calc(44px + env(safe-area-inset-top));
  padding-top: env(safe-area-inset-top);
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  background: #0d0a07;
  border-bottom: 2px solid var(--p1);
  box-shadow: 0 2px 14px var(--p1-glow);
  /* Opaque bar over a pannable board: swallow taps rather than letting them
     select whatever tile happens to be underneath. */
  pointer-events: auto;
  transition: border-color 0.25s ease, opacity 0.25s ease;
}
.mhud[data-player="1"] {
  border-bottom-color: var(--p2);
  box-shadow: 0 2px 14px var(--p2-glow);
}
/* AI turn: desaturated + dimmed. Nothing here is addressed to the player. */
.mhud[data-ai="1"] { opacity: 0.6; filter: saturate(0.45); }

/* ── Faction ribbon ── */
.mhud-ribbon {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 22px 0 14px;
  background: linear-gradient(100deg, var(--p1-dim), var(--p1) 70%, var(--p1));
  /* The skew: a 14px shear off the trailing edge. */
  clip-path: polygon(0 0, 100% 0, calc(100% - 14px) 100%, 0 100%);
  color: #fff3e6;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
}
.mhud[data-player="1"] .mhud-ribbon {
  background: linear-gradient(100deg, var(--p2-dim), var(--p2) 70%, var(--p2));
}
.mhud-ribbon-text { overflow: hidden; text-overflow: ellipsis; }
.mhud-pulse {
  flex: none;
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--gold);
  box-shadow: 0 0 8px var(--gold);
  animation: mhud-pulse 2.4s ease-in-out infinite;
}
@keyframes mhud-pulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}

/* ── Right cluster ── */
.mhud-right {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px 0 12px;
  flex: none;
}
.mhud-day {
  font-family: 'Fraunces', serif;
  font-style: italic;
  font-feature-settings: 'lnum' 'tnum';
  font-size: 15px;
  color: var(--gold);
  white-space: nowrap;
}
.mhud-funds {
  font-size: 12px;
  font-feature-settings: 'lnum' 'tnum';
  color: var(--gold);
  white-space: nowrap;
}
.mhud-overview {
  pointer-events: auto;
  appearance: none;
  flex: none;
  width: 32px; height: 32px;
  display: grid;
  place-items: center;
  background: var(--panel);
  border: 1px solid var(--rule);
  color: var(--ink-dim);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  border-radius: 6px;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.mhud-overview.on {
  border-color: var(--gold-dim);
  color: var(--gold);
}
`;
  const style = document.createElement('style');
  style.dataset.bats = 'hud-strip';
  style.textContent = css;
  document.head.appendChild(style);
}
