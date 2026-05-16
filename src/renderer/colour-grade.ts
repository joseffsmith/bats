// Per-map colour grade. A single globalCompositeOperation='multiply' fillRect
// at the end of the draw pipeline shifts the overall hue of the scene to fit
// the map's environment — cooler over open ocean, warmer over canyons, etc.
//
// Kept subtle (≥0.9 multiplier per channel) so unit colours, ownership tints,
// and the existing vignette still read clearly. The lookup is data; the
// blending is one fillRect.

import type { MapName } from './maps';
import type { Viewport } from './canvas';

export type RgbTint = { r: number; g: number; b: number };

/** Multipliers in [0,1]. A 1.0 channel is fully preserved; 0.92 nudges that
 *  channel down by 8%. Keep all three values within ±0.10 of each other so
 *  the grade reads as a tint, not a wash. */
export const MAP_TINTS: Record<MapName, RgbTint> = {
  // Neutral baseline — barely-perceptible cool wash so duel feels "clean".
  duel:       { r: 0.99, g: 0.99, b: 1.00 },
  // Highways and dust — warmer, slightly desaturated.
  crossroads: { r: 1.00, g: 0.97, b: 0.92 },
  // Cooler oceanic blue — supports the water-dominant board.
  armada:     { r: 0.92, g: 0.96, b: 1.00 },
  island_hop: { r: 0.94, g: 0.97, b: 1.00 },
  // Warm red rock — pushes the canyon palette toward sunset.
  canyon:     { r: 1.00, g: 0.93, b: 0.88 },
  // Cooler alpine green-blue.
  highlands:  { r: 0.95, g: 0.99, b: 0.97 },
};

export function drawColourGrade(
  ctx: CanvasRenderingContext2D,
  vp: Viewport,
  mapName: MapName | null | undefined,
): void {
  if (!mapName) return;
  const tint = MAP_TINTS[mapName];
  if (!tint) return;
  // Skip the work when the tint is effectively neutral.
  if (tint.r >= 0.999 && tint.g >= 0.999 && tint.b >= 0.999) return;
  const r = Math.max(0, Math.min(255, Math.round(tint.r * 255)));
  const g = Math.max(0, Math.min(255, Math.round(tint.g * 255)));
  const b = Math.max(0, Math.min(255, Math.round(tint.b * 255)));
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, vp.width, vp.height);
  ctx.restore();
}
