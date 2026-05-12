// Map editor.
//
// Activated by `?editor=1` on the renderer page. Provides a paint-mode tile
// editor on a fresh canvas. The user picks a brush from a palette (terrain
// type, or "owner-0 hq", "owner-1 factory", etc.) and clicks tiles to paint.
// Right-click clears a tile back to `plain` (with no owner).
//
// Save: serialise the painted map to the same JSON shape `loadMap` consumes,
// validate via loader (catching e.g. missing HQ), and download. If validation
// fails we surface the error message inline so the user can fix it.
//
// Load: file picker accepts an existing map JSON, repopulates the editor
// canvas, then save can round-trip it.
//
// The editor module is also unit-testable: `createEditor` returns an object
// with `paint`, `clear`, `setBrush`, `toJson` etc., so an integration test can
// drive it without a real DOM canvas.

import type { PlayerId, TerrainType } from '../engine/core/types';
import { loadMap } from '../engine/data/loader';
import { log } from '../engine/core/logger';

export const EDITOR_TILE_SIZE = 36;
export const DEFAULT_WIDTH = 16;
export const DEFAULT_HEIGHT = 12;

export type BrushTerrain = { kind: 'terrain'; terrain: TerrainType };
export type BrushOwned = {
  kind: 'owned';
  terrain: 'hq' | 'factory' | 'city';
  owner: PlayerId;
};
export type Brush = BrushTerrain | BrushOwned;

export type EditorTile = {
  terrain: TerrainType;
  owner: PlayerId | null;
};

export type EditorState = {
  width: number;
  height: number;
  tiles: EditorTile[][];
  name: string;
};

export type Editor = {
  state(): EditorState;
  paint(x: number, y: number, brush?: Brush): void;
  clear(x: number, y: number): void;
  setBrush(b: Brush): void;
  getBrush(): Brush;
  setSize(w: number, h: number): void;
  setName(name: string): void;
  /** Serialise into the JSON shape consumed by `loadMap`. */
  toJson(): unknown;
  /** Validate via loader. Returns null on success or the error message. */
  validate(): string | null;
  /** Reset the canvas back to all plain. */
  reset(w?: number, h?: number): void;
  /** Load an existing map JSON into the editor. */
  importJson(json: unknown): void;
};

/** Standard brush palette exposed to the UI. */
export const BRUSH_PALETTE: ReadonlyArray<Brush> = [
  { kind: 'terrain', terrain: 'plain' },
  { kind: 'terrain', terrain: 'road' },
  { kind: 'terrain', terrain: 'forest' },
  { kind: 'terrain', terrain: 'mountain' },
  { kind: 'terrain', terrain: 'sea' },
  { kind: 'owned', terrain: 'city', owner: 0 },
  { kind: 'owned', terrain: 'city', owner: 1 },
  { kind: 'owned', terrain: 'hq', owner: 0 },
  { kind: 'owned', terrain: 'hq', owner: 1 },
  { kind: 'owned', terrain: 'factory', owner: 0 },
  { kind: 'owned', terrain: 'factory', owner: 1 },
];

const DEFAULT_LEGEND = {
  '.': { terrain: 'plain' as TerrainType },
  R: { terrain: 'road' as TerrainType },
  F: { terrain: 'forest' as TerrainType },
  M: { terrain: 'mountain' as TerrainType },
  S: { terrain: 'sea' as TerrainType },
  C: { terrain: 'city' as TerrainType },
  c: { terrain: 'city' as TerrainType, owner: 0 as PlayerId },
  d: { terrain: 'city' as TerrainType, owner: 1 as PlayerId },
  '0': { terrain: 'hq' as TerrainType, owner: 0 as PlayerId },
  '1': { terrain: 'hq' as TerrainType, owner: 1 as PlayerId },
  a: { terrain: 'factory' as TerrainType, owner: 0 as PlayerId },
  b: { terrain: 'factory' as TerrainType, owner: 1 as PlayerId },
};

function emptyTiles(w: number, h: number): EditorTile[][] {
  const rows: EditorTile[][] = [];
  for (let y = 0; y < h; y++) {
    const row: EditorTile[] = [];
    for (let x = 0; x < w; x++) row.push({ terrain: 'plain', owner: null });
    rows.push(row);
  }
  return rows;
}

export function createEditor(): Editor {
  let width = DEFAULT_WIDTH;
  let height = DEFAULT_HEIGHT;
  let tiles = emptyTiles(width, height);
  let brush: Brush = { kind: 'terrain', terrain: 'plain' };
  let name = 'custom';

  function paint(x: number, y: number, b: Brush = brush): void {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const tile = tiles[y]![x]!;
    if (b.kind === 'terrain') {
      tile.terrain = b.terrain;
      tile.owner = null;
    } else {
      tile.terrain = b.terrain;
      tile.owner = b.owner;
      // HQ is unique per owner: if we just placed an HQ, scrub other HQs of
      // the same owner so the loader's "one HQ per player" invariant holds.
      if (b.terrain === 'hq') {
        for (let yy = 0; yy < height; yy++) {
          for (let xx = 0; xx < width; xx++) {
            if (xx === x && yy === y) continue;
            const t = tiles[yy]![xx]!;
            if (t.terrain === 'hq' && t.owner === b.owner) {
              t.terrain = 'plain';
              t.owner = null;
            }
          }
        }
      }
    }
    log('editor', 'paint', { x, y, brush: b });
  }

  function clear(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    tiles[y]![x] = { terrain: 'plain', owner: null };
    log('editor', 'clear', { x, y });
  }

  function findHq(owner: PlayerId): { x: number; y: number } | null {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const t = tiles[y]![x]!;
        if (t.terrain === 'hq' && t.owner === owner) return { x, y };
      }
    }
    return null;
  }

  function toJson(): unknown {
    const symbolOf = (t: EditorTile): string => {
      if (t.terrain === 'plain') return '.';
      if (t.terrain === 'road') return 'R';
      if (t.terrain === 'forest') return 'F';
      if (t.terrain === 'mountain') return 'M';
      if (t.terrain === 'sea') return 'S';
      if (t.terrain === 'city') {
        if (t.owner === 0) return 'c';
        if (t.owner === 1) return 'd';
        return 'C';
      }
      if (t.terrain === 'hq') return t.owner === 0 ? '0' : '1';
      if (t.terrain === 'factory') return t.owner === 0 ? 'a' : 'b';
      return '.';
    };
    const rows: string[] = [];
    for (let y = 0; y < height; y++) {
      let r = '';
      for (let x = 0; x < width; x++) r += symbolOf(tiles[y]![x]!);
      rows.push(r);
    }
    const hq0 = findHq(0);
    const hq1 = findHq(1);
    const out = {
      name,
      width,
      height,
      tiles: rows,
      tileLegend: DEFAULT_LEGEND,
      players: {
        0: { funds: 0, hq: hq0 ?? { x: 0, y: 0 } },
        1: { funds: 0, hq: hq1 ?? { x: 0, y: 0 } },
      },
      units: [] as unknown[],
    };
    return out;
  }

  function validate(): string | null {
    try {
      loadMap(toJson());
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  function setSize(w: number, h: number): void {
    width = w;
    height = h;
    tiles = emptyTiles(w, h);
  }

  function reset(w: number = width, h: number = height): void {
    setSize(w, h);
  }

  function importJson(json: unknown): void {
    // Use the loader so we benefit from validation. Then rebuild the tile
    // grid from the loaded GameState.
    const state = loadMap(json);
    name = (json as { name?: string }).name ?? 'custom';
    width = state.map[0]?.length ?? 0;
    height = state.map.length;
    tiles = [];
    for (let y = 0; y < height; y++) {
      const row: EditorTile[] = [];
      for (let x = 0; x < width; x++) {
        const t = state.map[y]![x]!;
        row.push({ terrain: t.terrain, owner: t.owner });
      }
      tiles.push(row);
    }
    log('editor', 'imported', { name, width, height });
  }

  return {
    state(): EditorState {
      return { width, height, tiles, name };
    },
    paint,
    clear,
    setBrush(b: Brush): void {
      brush = b;
      log('editor', 'brush set', { brush });
    },
    getBrush(): Brush {
      return brush;
    },
    setSize,
    setName(n: string): void {
      name = n;
    },
    toJson,
    validate,
    reset,
    importJson,
  };
}

// ─────────────────────────── DOM mount ───────────────────────────────────────

/** Mount the editor UI. Called from `main.ts` when `?editor=1`. */
export function runEditor(parent: HTMLElement): void {
  parent.innerHTML = '';
  const editor = createEditor();

  const root = document.createElement('div');
  root.style.cssText = 'display: flex; flex-direction: column; gap: 6px; padding: 12px; color: #e6ecff; font: 13px -apple-system, BlinkMacSystemFont, sans-serif;';
  parent.appendChild(root);

  // Toolbar.
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display: flex; gap: 6px; flex-wrap: wrap; align-items: center;';
  const title = document.createElement('strong');
  title.textContent = 'Map Editor';
  toolbar.appendChild(title);

  const nameInput = document.createElement('input');
  nameInput.value = editor.state().name;
  nameInput.placeholder = 'map name';
  nameInput.style.cssText = 'background: #14161e; color: #e6ecff; border: 1px solid #3a3e50; padding: 2px 6px;';
  nameInput.addEventListener('input', () => editor.setName(nameInput.value));
  toolbar.appendChild(nameInput);

  const widthInput = numberInput('w', editor.state().width);
  const heightInput = numberInput('h', editor.state().height);
  const resizeBtn = makeButton('Resize');
  resizeBtn.addEventListener('click', () => {
    const w = Math.max(2, Math.min(40, Number(widthInput.value) || DEFAULT_WIDTH));
    const h = Math.max(2, Math.min(40, Number(heightInput.value) || DEFAULT_HEIGHT));
    editor.setSize(w, h);
    redraw();
  });
  toolbar.append(widthInput, heightInput, resizeBtn);

  const saveBtn = makeButton('Save');
  const loadBtn = makeButton('Load');
  const validateBtn = makeButton('Validate');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.style.display = 'none';
  toolbar.append(validateBtn, saveBtn, loadBtn, fileInput);

  root.appendChild(toolbar);

  // Brush palette.
  const palette = document.createElement('div');
  palette.style.cssText = 'display: flex; gap: 4px; flex-wrap: wrap;';
  for (const b of BRUSH_PALETTE) {
    const btn = makeButton(brushLabel(b));
    btn.addEventListener('click', () => {
      editor.setBrush(b);
      // Highlight the active brush.
      for (let i = 0; i < palette.children.length; i++) {
        (palette.children[i] as HTMLElement).style.outline = '';
      }
      btn.style.outline = '2px solid #ffd84a';
    });
    palette.appendChild(btn);
  }
  root.appendChild(palette);

  // Status.
  const status = document.createElement('div');
  status.style.cssText = 'min-height: 1.4em; opacity: 0.85;';
  root.appendChild(status);

  // Canvas.
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'border: 1px solid #3a3e50; cursor: crosshair; background: #0a0d14;';
  root.appendChild(canvas);

  function redraw(): void {
    const st = editor.state();
    const ts = EDITOR_TILE_SIZE;
    canvas.width = st.width * ts;
    canvas.height = st.height * ts;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    for (let y = 0; y < st.height; y++) {
      for (let x = 0; x < st.width; x++) {
        const tile = st.tiles[y]![x]!;
        ctx.fillStyle = terrainFill(tile.terrain);
        ctx.fillRect(x * ts, y * ts, ts, ts);
        if (tile.owner !== null) {
          ctx.fillStyle = tile.owner === 0 ? '#c83030' : '#2860c0';
          ctx.fillRect(x * ts + ts - 8, y * ts + 2, 6, 6);
        }
        // Letter for terrain disambiguation.
        const letter = terrainLetter(tile.terrain);
        if (letter) {
          ctx.fillStyle = '#0a0a0a';
          ctx.font = 'bold 12px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(letter, x * ts + ts / 2, y * ts + ts / 2);
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.strokeRect(x * ts + 0.5, y * ts + 0.5, ts - 1, ts - 1);
      }
    }
  }

  function pxToTile(ev: MouseEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.floor((ev.clientX - r.left) / EDITOR_TILE_SIZE),
      y: Math.floor((ev.clientY - r.top) / EDITOR_TILE_SIZE),
    };
  }

  canvas.addEventListener('mousedown', (ev) => {
    const t = pxToTile(ev);
    if (ev.button === 2) editor.clear(t.x, t.y);
    else editor.paint(t.x, t.y);
    redraw();
  });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  validateBtn.addEventListener('click', () => {
    const err = editor.validate();
    if (err) {
      status.textContent = `Invalid: ${err}`;
      status.style.color = '#ff8888';
    } else {
      status.textContent = 'Valid';
      status.style.color = '#7ed957';
    }
  });

  saveBtn.addEventListener('click', () => {
    const err = editor.validate();
    if (err) {
      status.textContent = `Cannot save — invalid: ${err}`;
      status.style.color = '#ff8888';
      return;
    }
    const blob = new Blob([JSON.stringify(editor.toJson(), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${editor.state().name}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    status.textContent = `Saved as ${editor.state().name}.json`;
    status.style.color = '#7ed957';
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
        const json = JSON.parse(String(reader.result ?? ''));
        editor.importJson(json);
        nameInput.value = editor.state().name;
        widthInput.value = String(editor.state().width);
        heightInput.value = String(editor.state().height);
        redraw();
        status.textContent = 'Loaded';
        status.style.color = '#7ed957';
      } catch (err) {
        status.textContent = `Load failed: ${err instanceof Error ? err.message : String(err)}`;
        status.style.color = '#ff8888';
      }
    };
    reader.readAsText(file);
  });

  redraw();
  log('editor', 'editor mounted', { width: editor.state().width, height: editor.state().height });
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

function numberInput(label: string, value: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = String(value);
  input.title = label;
  input.style.cssText = 'width: 56px; background: #14161e; color: #e6ecff; border: 1px solid #3a3e50; padding: 2px 4px;';
  return input;
}

function brushLabel(b: Brush): string {
  if (b.kind === 'terrain') return b.terrain;
  return `P${b.owner + 1} ${b.terrain}`;
}

function terrainFill(t: TerrainType): string {
  switch (t) {
    case 'plain':
      return '#c9d59a';
    case 'road':
      return '#bcb6a4';
    case 'forest':
      return '#3e6a3a';
    case 'mountain':
      return '#7a5a3a';
    case 'sea':
      return '#1f4d8a';
    case 'city':
      return '#e8d680';
    case 'hq':
      return '#bfa030';
    case 'factory':
      return '#6e7480';
  }
}

function terrainLetter(t: TerrainType): string {
  switch (t) {
    case 'forest':
      return 'F';
    case 'mountain':
      return 'M';
    case 'city':
      return 'C';
    case 'hq':
      return 'H';
    case 'factory':
      return 'X';
    default:
      return '';
  }
}
