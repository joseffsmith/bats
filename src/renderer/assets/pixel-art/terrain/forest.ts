// Forest — the plain green floor (`g`) with three chunky AW-style trees. Each
// tree is a rounded canopy blob shaded dark→light (`e`/`f`/`F`) with the light
// catch on its top-left, over a short `t` trunk. The trees sit inside the tile
// with a grass margin, so forest cells tile against plain (and each other)
// without the canopies fusing at the seam.

import type { PixelGrid } from '../types';

export const forest: PixelGrid = [
  'gggggggggggggggg',
  'gggggggggggggggg',
  'gggFFggggggggggg',
  'ggFFffegggFFgggg',
  'ggFfffeggFFffegg',
  'ggffeeeggFfffegg',
  'gggeeegggffeeegg',
  'ggggtgggggeeeggg',
  'ggggggFFgggtgggg',
  'gggggFFffegggggg',
  'gggggFfffegggggg',
  'gggggffeeegggggg',
  'ggggggeeeggggggg',
  'gggggggtgggggggg',
  'gggggggggggggggg',
  'gggggggggggggggg',
];
