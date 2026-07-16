// Damage decal shared by every 'damaged' sprite variant.
//
// The bake (sprites.ts) makes a damaged sprite in two moves: darken the whole
// unit ~35% (a unit that's taken a beating reads dimmer), then stamp this decal
// on top *only where the unit is opaque* — scorch marks and a couple of embers
// scattered toward the lower-right (the shadow side, so the scarring sits where
// the light doesn't). Empty cells never touch bare tile; the decal is a mask,
// not an outline.
//
// Cells: 'S' soot (near-black warm), 'W' gold ember, '.' no mark. Both non-'.'
// chars are FIXED_PALETTE colours so the same char→RGBA path bakes them.

import type { PixelGrid } from './types';

export const SOOT_DECAL: PixelGrid = [
  '................',
  '................',
  '................',
  '..........S.....',
  '...........SS...',
  '..........SW....',
  '....S.....S.....',
  '...SS......S....',
  '....S....S.S....',
  '.........SW.....',
  '......S...SS....',
  '.....S...S......',
  '......SS...S....',
  '.......S...S....',
  '................',
  '................',
];
