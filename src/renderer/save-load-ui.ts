// Tiny floating DOM panel exposing Save / Load buttons.
//
// Save: serialise current state + trigger a file download.
// Load: file picker → deserialise → emitter.setState. On error, surface the
//   exception in a transient status line so the user sees what went wrong.
//
// We keep the panel as DOM (not canvas) so the file-picker + a11y bits are
// trivial. Sits next to the AI control panel.

import { deserialize, downloadSave } from '../engine/save';
import type { Emitter } from './emitter';
import { log } from '../engine/core/logger';

export function mountSaveLoadPanel(parent: HTMLElement, emitter: Emitter): HTMLElement {
  const panel = document.createElement('div');
  panel.setAttribute('data-bats-panel', 'save-load');
  panel.style.cssText = [
    'position: fixed',
    'top: 8px',
    'left: 8px',
    'z-index: 10',
    'background: rgba(20,20,28,0.92)',
    'color: #e6ecff',
    'border: 1px solid #3a3e50',
    'border-radius: 4px',
    'padding: 6px 10px',
    'font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'display: flex',
    'gap: 8px',
    'align-items: center',
  ].join(';');

  const saveBtn = makeButton('Save');
  const loadBtn = makeButton('Load');
  const status = document.createElement('span');
  status.style.cssText = 'opacity: 0.7; min-width: 80px;';

  // Hidden file input that we trigger programmatically.
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.style.display = 'none';

  saveBtn.addEventListener('click', () => {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      downloadSave(emitter.getState(), `bats-save-${ts}.json`);
      flash(status, 'saved', '#7ed957');
      log('engine', 'save downloaded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      flash(status, `save failed: ${msg}`, '#ff8888');
    }
  });

  loadBtn.addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (): void => {
      try {
        const json = String(reader.result ?? '');
        const state = deserialize(json);
        emitter.setState(state);
        flash(status, 'loaded', '#7ed957');
        log('engine', 'save loaded', { turn: state.turn, units: Object.keys(state.units).length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        flash(status, `load failed: ${msg}`, '#ff8888');
      }
    };
    reader.onerror = (): void => {
      flash(status, 'load failed: read error', '#ff8888');
    };
    reader.readAsText(file);
  });

  const title = document.createElement('span');
  title.textContent = 'State:';
  title.style.cssText = 'opacity: 0.6; font-weight: 600;';
  panel.appendChild(title);
  panel.appendChild(saveBtn);
  panel.appendChild(loadBtn);
  panel.appendChild(status);
  panel.appendChild(fileInput);
  parent.appendChild(panel);
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

function flash(el: HTMLElement, msg: string, colour: string): void {
  el.textContent = msg;
  el.style.color = colour;
  window.setTimeout(() => {
    if (el.textContent === msg) {
      el.textContent = '';
      el.style.color = '';
    }
  }, 2400);
}
