// Player palette constants extracted from canvas.ts so other renderer modules
// (sprites, save/load UI, audio) can import the colours without dragging in
// the full draw pipeline.

import type { PlayerId } from '../engine/core/types';

export type PlayerPalette = { fill: string; letter: string };

export const PLAYER_COLOURS: Record<PlayerId, PlayerPalette> = {
  0: { fill: '#c83030', letter: '#fff5d0' }, // crimson red w/ pale yellow letter
  1: { fill: '#2860c0', letter: '#e6ecff' }, // royal blue w/ pale blue letter
};
