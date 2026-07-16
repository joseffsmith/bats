// Player palette constants extracted from canvas.ts so other renderer modules
// (sprites, save/load UI, audio) can import the colours without dragging in
// the full draw pipeline.

import type { PlayerId } from '../engine/core/types';

// A 4-stop team ramp, dark→light, resolved into the sprite grids' A/B/C/D cells
// at bake time (see assets/pixel-art/palette.ts). The ramp is the whole army-
// colour identity: Advance-Wars-style the *body* of every unit is painted from
// it, so it has to read clearly across the crimson/cobalt divide at tile size.
//   [0] A shadow — lower-right facing surfaces, under-hull
//   [1] B base   — the bulk of the body; this is "the" player colour
//   [2] C light  — top-left lit surfaces
//   [3] D highlight — the single brightest catch (turret crown, canopy frame)
export type TeamRamp = readonly [string, string, string, string];

export type PlayerPalette = { fill: string; letter: string; ramp: TeamRamp };

// Ramps are built around the existing base hues (p0 #c83030 crimson, p1 #2860c0
// cobalt) so nothing else in the UI shifts. Shadows are deep and desaturated
// enough to seat the form; highlights push warm (crimson) / bright (cobalt) so
// the top-left catch pops one clear step above the base without going pastel.
export const PLAYER_COLOURS: Record<PlayerId, PlayerPalette> = {
  0: {
    fill: '#c83030', // crimson base (unchanged — HUD/fallback squares use this)
    letter: '#fff5d0', // pale yellow letter (fallback square)
    ramp: ['#6e1616', '#c83030', '#e05a4a', '#f2937f'],
  },
  1: {
    fill: '#2860c0', // cobalt base (unchanged — HUD/fallback squares use this)
    letter: '#e6ecff', // pale blue letter (fallback square)
    // Base + light pushed brighter and more saturated than the HUD `fill` so
    // cobalt hulls separate from the sea blues in-game (the darker #2860c0 read
    // as camouflage on water). Only the sprite ramp shifts; `fill` stays put so
    // the HUD/chrome pairing is unchanged. Brighter blue on green only *helps*
    // land units, so nothing regresses there.
    ramp: ['#14306e', '#2f78e6', '#5fa0f5', '#a6cbfb'],
  },
};
