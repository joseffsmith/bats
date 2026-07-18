// Sea — three blues (`b` deep, `s` mid, `c` crest) with sparse `w` foam flecks.
// The mid tone `s` fills every edge so a 4×4 block of identical sea tiles seams
// invisibly; the darker patches and brighter ripples/foam are scattered
// irregularly in the interior so the surface reads as water, not a grid. Kept
// low-contrast on purpose — a bold repeat would betray the tile boundary.

import type { PixelGrid } from '../types';

export const sea: PixelGrid = [
  'ssssssssssssssss',
  'ssssssssssssssss',
  'ssssscssssssssss',
  'ssssssssssssssss',
  'ssssssssssbbssss',
  'ssssssssssssssss',
  'sscsssssssssssss',
  'ssssssssssssswss',
  'ssssssssssssssss',
  'sssssbbsssssssss',
  'ssssssssssssssss',
  'ssssssssssscssss',
  'ssssssssssssssss',
  'sssssssscsssssss',
  'ssswssssssssssss',
  'ssssssssssssssss',
];
