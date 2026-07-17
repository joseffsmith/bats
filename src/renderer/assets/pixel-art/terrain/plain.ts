// Plain — the board's default ground. A flat warm-green field (base `g`) with
// a sparse scatter of one-step-lighter (`G`) and one-step-darker (`v`) dapples
// for texture. The scatter is deliberately irregular and kept low-contrast: a
// regular or high-contrast pattern would tile into a visible 16px grid, since
// every plain cell bakes to the same tile. The outer ring stays base `g` so
// neighbouring plains seam invisibly.

import type { PixelGrid } from '../types';

export const plain: PixelGrid = [
  'gggggggggggggggg',
  'gggggggggggggggg',
  'gggGgggggggggggg',
  'ggggggggvgggGggg',
  'gggggggggggggggg',
  'gggggggGgggggggg',
  'gggggggggggggvgg',
  'gggggggggggggggg',
  'gggvgggggggggggg',
  'gGgggggggggggggg',
  'ggggggggggGggggg',
  'gggggggggggvgggg',
  'gggggGgggggggggg',
  'gggggggggggggggg',
  'gggggggggggggggg',
  'gggggggggggggggg',
];
