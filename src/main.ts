// Phase 0 entry point: render a grey canvas filling the viewport with a
// centred title. No game logic yet — see PLAN.md.

import { log } from './engine/core/logger';

const TILE_SIZE = 48;
const GRID_COLS = 12;
const GRID_ROWS = 8;

function setupCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const existing = document.querySelector('canvas');
  const canvas = existing ?? document.createElement('canvas');
  if (!existing) {
    const app = document.getElementById('app');
    if (app) {
      app.appendChild(canvas);
    } else {
      document.body.appendChild(canvas);
    }
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context unavailable');
  }
  return { canvas, ctx };
}

function resize(canvas: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function draw(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  // Grey background.
  ctx.fillStyle = '#2b2b2b';
  ctx.fillRect(0, 0, w, h);

  // Faint grid overlay so we can visually confirm tile size for later phases.
  const gridW = GRID_COLS * TILE_SIZE;
  const gridH = GRID_ROWS * TILE_SIZE;
  const originX = Math.floor((w - gridW) / 2);
  const originY = Math.floor((h - gridH) / 2);

  ctx.strokeStyle = '#3a3a3a';
  ctx.lineWidth = 1;
  for (let x = 0; x <= GRID_COLS; x++) {
    const px = originX + x * TILE_SIZE + 0.5;
    ctx.beginPath();
    ctx.moveTo(px, originY);
    ctx.lineTo(px, originY + gridH);
    ctx.stroke();
  }
  for (let y = 0; y <= GRID_ROWS; y++) {
    const py = originY + y * TILE_SIZE + 0.5;
    ctx.beginPath();
    ctx.moveTo(originX, py);
    ctx.lineTo(originX + gridW, py);
    ctx.stroke();
  }

  // Title.
  ctx.fillStyle = '#e6e6e6';
  ctx.font = '600 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Tactical Engine — Phase 0', w / 2, originY - 40);
}

function main(): void {
  const { canvas, ctx } = setupCanvas();
  const render = (): void => {
    resize(canvas);
    draw(canvas, ctx);
  };
  render();
  window.addEventListener('resize', render);
  log('engine', 'phase 0 boot complete', { tile: TILE_SIZE, grid: [GRID_COLS, GRID_ROWS] });
}

main();
