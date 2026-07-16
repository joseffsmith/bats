// DOM action + build menus.
//
// These replaced the canvas-drawn popovers from hud.ts (Phase 2.3). Rendering
// menus as DOM buys three things the canvas couldn't: native click swallowing
// (the menu sits ABOVE the canvas so a tap on an entry never reaches the board
// input handler), CSS-driven responsive layouts (desktop popover vs. touch
// bottom-sheet), and real scrolling for the tall 14-entry coastal roster.
//
// The module owns no state: on every emitter `stateChanged` (and the input
// controller's node-transition emissions, which are `stateChanged` with
// `action:null`) it re-reads `input.getOverlay()` and rebuilds the open menu, if
// any. Entries call `input.chooseAction` / `input.chooseBuild`; the input
// controller validates and drives the state machine as before.
//
// Layout, by pointer type (matchMedia('(pointer: coarse)')):
//   fine   → popover anchored one tile to the right of the menu tile, clamped
//            into the board band + viewport (mirrors the old canvas layout).
//   coarse → build menu is a bottom sheet (scrolls, safe-area padded); action
//            menu is a bottom action bar of big buttons.
//
// The root is pointer-events:none (canvas clicks pass through the void); only
// the menu panel opts back in, so clicking the board *around* an open menu still
// reaches the canvas and cancels — matching chrome.ts's pattern.

import type { UnitType } from '../engine/core/types';
import type { BuildMenuEntry, CanvasRenderer, Overlay } from './canvas';
import type { Emitter } from './emitter';
import type { InputController } from './input';
import { UNIT_LETTER } from './hud';

export type Menus = {
  destroy(): void;
};

export type MenusDeps = {
  parent: HTMLElement;
  emitter: Emitter;
  input: InputController;
  renderer: CanvasRenderer;
};

/** True when the primary pointer is coarse (touch). Guarded for jsdom. */
function isCoarsePointer(): boolean {
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}

export function createMenus(deps: MenusDeps): Menus {
  ensureStyle();

  const root = document.createElement('div');
  root.className = 'menus-root';
  deps.parent.appendChild(root);

  function render(): void {
    const overlay = deps.input.getOverlay();
    // Rebuild from scratch — menus are small and only re-render on transitions,
    // not per frame, so the churn is negligible and the code stays diff-free.
    root.replaceChildren();
    if (overlay.buildMenu) {
      renderBuildMenu(root, overlay.buildMenu, deps);
    } else if (overlay.actionMenu) {
      renderActionMenu(root, overlay.actionMenu, deps);
    }
  }

  // Re-render on every game-state change AND every input-node transition. Both
  // arrive as `stateChanged` (the input controller emits it with `action:null`
  // on each transition), so subscribing to that one event type is sufficient.
  const unsub = deps.emitter.on((ev) => {
    if (ev.type === 'stateChanged') render();
  });

  render();

  return {
    destroy(): void {
      unsub();
      root.remove();
    },
  };
}

// ─────────────────────────── Action menu ─────────────────────────────────────

function renderActionMenu(
  root: HTMLElement,
  menu: NonNullable<Overlay['actionMenu']>,
  deps: MenusDeps,
): void {
  const coarse = isCoarsePointer();
  const el = document.createElement('div');
  el.className = coarse ? 'menu menu-action menu-bar' : 'menu menu-action menu-popover';

  for (const entry of menu.entries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-entry';
    btn.dataset.menuEntry = entry.label;
    btn.textContent = entry.label;
    btn.disabled = !entry.enabled;
    btn.addEventListener('click', () => deps.input.chooseAction(entry.label));
    el.appendChild(btn);
  }

  root.appendChild(el);
  if (!coarse) positionPopover(el, menu.tile, deps.renderer);
}

// ─────────────────────────── Build menu ──────────────────────────────────────

function renderBuildMenu(
  root: HTMLElement,
  menu: NonNullable<Overlay['buildMenu']>,
  deps: MenusDeps,
): void {
  const coarse = isCoarsePointer();
  const el = document.createElement('div');
  el.className = coarse ? 'menu menu-build menu-sheet' : 'menu menu-build menu-popover';

  if (coarse) {
    const title = document.createElement('div');
    title.className = 'menu-sheet-title';
    title.textContent = 'Build';
    el.appendChild(title);
  }

  const list = document.createElement('div');
  list.className = 'menu-build-list';
  for (const entry of menu.entries) {
    list.appendChild(makeBuildEntry(entry, deps.input));
  }
  el.appendChild(list);

  root.appendChild(el);
  if (!coarse) positionPopover(el, menu.tile, deps.renderer);
}

function makeBuildEntry(entry: BuildMenuEntry, input: InputController): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'menu-entry build-entry';
  btn.dataset.buildEntry = entry.unitType;
  btn.disabled = !entry.affordable;

  // Player-neutral letter chip (Phase 3 swaps this for a sprite image).
  const chip = document.createElement('span');
  chip.className = 'build-chip';
  chip.textContent = UNIT_LETTER[entry.unitType as UnitType];

  const label = document.createElement('span');
  label.className = 'build-label';
  label.textContent = entry.label;

  const cost = document.createElement('span');
  cost.className = 'build-cost';
  cost.textContent = `$${entry.cost.toLocaleString('en-US')}`;

  btn.appendChild(chip);
  btn.appendChild(label);
  btn.appendChild(cost);
  btn.addEventListener('click', () => input.chooseBuild(entry.unitType));
  return btn;
}

// ─────────────────────────── Popover positioning ─────────────────────────────

/**
 * Place a fine-pointer popover one tile to the RIGHT of its anchor tile,
 * flipping left if it would run off the right edge, and clamping into the board
 * band (between the measured chrome insets) + the viewport width. Reuses the
 * geometry intent of the old canvas `actionMenuLayout` / `buildMenuLayout`.
 * Measured from the element's own laid-out size, so it works for any entry count.
 */
function positionPopover(
  el: HTMLElement,
  tile: { x: number; y: number },
  renderer: CanvasRenderer,
): void {
  const vp = renderer.getViewport();
  const p = renderer.tileToPixel(tile);
  const w = el.offsetWidth;
  const h = el.offsetHeight;

  let left = p.x + vp.tileSize + 8;
  if (left + w > vp.width - 8) left = p.x - w - 8; // flip to the tile's left
  left = Math.max(8, Math.min(left, vp.width - 8 - w));

  const bandTop = vp.insetTop + 4;
  const bandBottom = vp.height - vp.insetBottom - 4;
  let top = p.y;
  if (top + h > bandBottom) top = bandBottom - h;
  if (top < bandTop) top = bandTop;

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

// ─────────────────────────── Styles ──────────────────────────────────────────

let stylesInjected = false;

function ensureStyle(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.menus-root {
  position: fixed;
  inset: 0;
  pointer-events: none;
  /* Above the chrome bars (z 10) so an open sheet/popover is never occluded,
     below the winner overlay (90) + replay modal (100). */
  z-index: 15;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
}

/* Only the menu panel takes clicks; the void around it passes through to the
   canvas so clicking the board elsewhere still cancels. */
.menu {
  pointer-events: auto;
  background: var(--panel);
  border: 1px solid var(--rule-strong);
  box-shadow: 0 20px 50px -18px rgba(0,0,0,0.8);
}

/* ── Fine-pointer popover ── */
.menu-popover {
  position: absolute;
  display: flex;
  flex-direction: column;
  min-width: 132px;
  padding: 4px;
  gap: 2px;
}
.menu-build.menu-popover { min-width: 210px; }
.menu-build.menu-popover .menu-build-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* Tall rosters (14 coastal entries) scroll inside the popover rather than
     overflowing the board band — every entry stays reachable. */
  max-height: min(60vh, 460px);
  overflow-y: auto;
}

/* ── Menu entries ── */
.menu-entry {
  appearance: none;
  background: var(--panel-2);
  border: 1px solid var(--rule);
  color: var(--ink);
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 9px 12px;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.12s ease, background 0.12s ease, color 0.12s ease;
}
.menu-entry:hover:not(:disabled) {
  border-color: var(--gold-dim);
  background: var(--panel);
  color: var(--ink);
}
.menu-entry:disabled {
  color: var(--ink-faint);
  opacity: 0.5;
  cursor: default;
}

/* ── Build entries: letter chip + label + cost ── */
.build-entry {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
  text-transform: none;
  letter-spacing: 0.02em;
}
.build-chip {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  background: var(--rule);
  color: var(--ink);
  font-weight: 700;
  font-size: 14px;
  border-radius: 2px;
}
.build-entry:disabled .build-chip { background: #2a2a2a; color: var(--ink-faint); }
.build-label {
  font-size: 12.5px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.build-cost {
  font-family: 'Fraunces', serif;
  font-feature-settings: 'lnum' 'tnum';
  color: var(--gold);
  font-size: 13px;
  font-weight: 500;
}
.build-entry:disabled .build-cost { color: var(--gold-dim); }

/* ── Coarse-pointer bottom sheet (build) ── */
.menu-sheet {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  max-height: 55vh;
  border-left: none;
  border-right: none;
  border-bottom: none;
  padding-bottom: calc(6px + env(safe-area-inset-bottom));
}
.menu-sheet .menu-sheet-title {
  flex: 0 0 auto;
  padding: 12px 16px 8px;
  font-size: 11px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--gold-dim);
}
.menu-sheet .menu-build-list {
  /* min-height:0 lets this flex child shrink below its content height so its
     own overflow-y:auto scrolls the roster inside the capped sheet (without it
     the list would expand and spill past the sheet). */
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 0 12px 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.menu-sheet .build-entry {
  min-height: 48px;
  padding: 10px 14px;
}

/* ── Coarse-pointer bottom action bar (action) ── */
.menu-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  gap: 8px;
  padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
  border-left: none;
  border-right: none;
  border-bottom: none;
  overflow-x: auto;
}
.menu-bar .menu-entry {
  flex: 1 1 0;
  min-height: 48px;
  min-width: 84px;
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
}
`;
  const style = document.createElement('style');
  style.dataset.bats = 'menus';
  style.textContent = css;
  document.head.appendChild(style);
}
