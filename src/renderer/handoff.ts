// Hot-seat fog handoff interstitial.
//
// With `?fog=on` and two HUMAN players sharing one screen, pressing End Turn
// instantly re-renders the board from the NEXT player's vision — which the player
// currently at the keyboard would see, leaking the whole point of fog. This
// module inserts a pass-the-device moment: after every END_TURN it drops a
// full-viewport OPAQUE scrim (the board must be completely hidden — the vision
// leak is exactly what we're covering) that only lifts when the incoming player
// taps "Begin turn".
//
// Scope (all must hold, checked at each END_TURN):
//   - fog is on AND there's no fixed viewer override (`?view=`) — folded into the
//     `fogOn` dep by main.ts;
//   - BOTH controllers are human — read LIVE via `bothHuman()` since the AI
//     dropdowns can switch a player mid-game;
//   - the match isn't already won.
// Boot is deliberately NOT covered: player 0 opens on their own vision, so there's
// nothing to hand over yet. The scrim only appears on turn handoff.
//
// While active the scrim's own `pointer-events: auto` blocks canvas clicks
// natively; main.ts additionally folds `!isActive()` into the Enter-to-end-turn
// predicate so the keyboard can't end a turn behind the scrim.

import type { PlayerId } from '../engine/core/types';
import type { Emitter } from './emitter';

const PLAYER_NAMES: Record<PlayerId, string> = { 0: 'Vermilion', 1: 'Cobalt' };
const PLAYER_NUMERALS: Record<PlayerId, string> = { 0: 'I', 1: 'II' };

export type Handoff = {
  /** True while the pass-the-device scrim is up. */
  isActive(): boolean;
  destroy(): void;
};

export type HandoffDeps = {
  parent: HTMLElement;
  emitter: Emitter;
  /** Fog on AND no fixed viewer override (main.ts folds `?view=` in here). */
  fogOn: boolean;
  /** Read LIVE at each END_TURN — controllers switch via the dropdowns. */
  bothHuman: () => boolean;
  /** Extra "the match is over" predicate, ORed into the `state.winner` guard:
   *  there is nobody to pass the device to once the day cap has adjudicated
   *  the match (src/renderer/adjudication.ts), and the scrim would otherwise
   *  land on top of the verdict overlay. Defaults to false. */
  matchConcluded?: () => boolean;
};

export function createHandoff(deps: HandoffDeps): Handoff {
  ensureStyle();

  const root = document.createElement('div');
  root.className = 'handoff-scrim';
  root.hidden = true;

  const dialog = document.createElement('div');
  dialog.className = 'handoff-dialog';

  const eyebrow = document.createElement('div');
  eyebrow.className = 'handoff-eyebrow';
  eyebrow.textContent = 'Pass the device';

  const marker = document.createElement('div');
  marker.className = 'handoff-marker';

  const title = document.createElement('h2');
  title.className = 'handoff-title';

  const subtitle = document.createElement('div');
  subtitle.className = 'handoff-subtitle';
  subtitle.textContent = 'The board stays hidden until you begin.';

  const beginBtn = document.createElement('button');
  beginBtn.type = 'button';
  beginBtn.className = 'handoff-begin';
  beginBtn.dataset.action = 'begin-turn';
  beginBtn.textContent = 'Begin turn';
  beginBtn.addEventListener('click', () => hide());

  dialog.appendChild(eyebrow);
  dialog.appendChild(marker);
  dialog.appendChild(title);
  dialog.appendChild(subtitle);
  dialog.appendChild(beginBtn);
  root.appendChild(dialog);
  deps.parent.appendChild(root);

  let active = false;

  function show(pid: PlayerId): void {
    active = true;
    root.dataset.player = String(pid);
    marker.textContent = PLAYER_NUMERALS[pid];
    title.textContent = `Pass to ${PLAYER_NAMES[pid]}`;
    root.hidden = false;
    // The scrim's pointer-events block the mouse, but a mouse-click on the End
    // Turn button leaves it DOM-focused — Enter would then activate that focused
    // button (bypassing the endTurnAllowed predicate, which only guards the
    // window keydown handler) and steal the incoming player's turn. Drop focus
    // so no button behind the scrim can be keyboard-activated. We deliberately
    // do NOT focus the Begin button: Enter must stay inert until it's clicked.
    const activeEl = document.activeElement;
    if (activeEl instanceof HTMLElement) activeEl.blur();
  }

  function hide(): void {
    active = false;
    root.hidden = true;
  }

  const unsub = deps.emitter.on((ev) => {
    if (ev.type !== 'stateChanged') return;
    // Only a freshly-APPLIED END_TURN is a handoff (the emitter nulls `action`
    // for no-ops / setState refreshes, so this also ignores replay scrubbing).
    if (ev.action?.type !== 'END_TURN') return;
    if (!deps.fogOn) return;
    if (!deps.bothHuman()) return;
    if (ev.state.winner !== null) return;
    if (deps.matchConcluded?.()) return;
    show(ev.state.currentPlayer);
  });

  return {
    isActive: () => active,
    destroy(): void {
      unsub();
      root.remove();
    },
  };
}

// ─────────────────────────── Styles ──────────────────────────────────────────
// Mirrors the winner overlay's modal idiom (chrome.ts) — same theme vars, same
// dialog/eyebrow/title rhythm — but the scrim itself is OPAQUE (var(--bg)) rather
// than a translucent wash: hiding the board is the entire purpose.

let stylesInjected = false;

function ensureStyle(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.handoff-scrim {
  position: fixed;
  inset: 0;
  z-index: 95;
  background: var(--bg);
  display: grid;
  place-items: center;
  pointer-events: auto;
  animation: handoff-fade 0.25s ease both;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
}
.handoff-scrim[hidden] { display: none; }
@keyframes handoff-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.handoff-dialog {
  background: var(--panel);
  border: 1px solid var(--rule-strong);
  padding: 34px 48px 30px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  min-width: 340px;
  box-shadow: 0 30px 80px -16px rgba(0,0,0,0.85);
}
.handoff-scrim[data-player="0"] .handoff-dialog {
  border-top: 3px solid var(--p1);
  box-shadow: 0 30px 80px -16px rgba(0,0,0,0.85), 0 0 60px -10px var(--p1-glow);
}
.handoff-scrim[data-player="1"] .handoff-dialog {
  border-top: 3px solid var(--p2);
  box-shadow: 0 30px 80px -16px rgba(0,0,0,0.85), 0 0 60px -10px var(--p2-glow);
}
.handoff-eyebrow {
  font-size: 10px;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--gold-dim);
}
.handoff-marker {
  width: 56px; height: 56px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-family: 'Fraunces', serif;
  font-weight: 600;
  font-size: 18px;
  letter-spacing: 0.06em;
  position: relative;
}
.handoff-marker::after {
  content: '';
  position: absolute;
  inset: -5px;
  border-radius: 50%;
  border: 1px solid currentColor;
  opacity: 0.32;
}
.handoff-scrim[data-player="0"] .handoff-marker {
  background: var(--p1); color: #2a0c0c; box-shadow: 0 0 20px var(--p1-glow);
}
.handoff-scrim[data-player="1"] .handoff-marker {
  background: var(--p2); color: #0a1e2a; box-shadow: 0 0 20px var(--p2-glow);
}
.handoff-title {
  margin: 0;
  font-family: 'Fraunces', serif;
  font-weight: 500;
  font-size: 30px;
  line-height: 1.1;
  color: var(--ink);
  font-variation-settings: 'opsz' 144, 'SOFT' 30;
}
.handoff-scrim[data-player="0"] .handoff-title { color: var(--p1); }
.handoff-scrim[data-player="1"] .handoff-title { color: var(--p2); }
.handoff-subtitle {
  font-size: 11.5px;
  color: var(--ink-dim);
  letter-spacing: 0.06em;
  margin-bottom: 8px;
}
.handoff-begin {
  background: var(--panel-2);
  border: 1px solid var(--gold-dim);
  color: var(--ink);
  padding: 11px 26px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.handoff-begin:hover {
  background: var(--gold-dim);
  border-color: var(--gold);
  color: #1a1410;
}
`;
  const style = document.createElement('style');
  style.dataset.bats = 'handoff';
  style.textContent = css;
  document.head.appendChild(style);
}
