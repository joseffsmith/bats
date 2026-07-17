// Road — a warm tan surface that fills the whole tile. Orientation-neutral by
// design (like the old full-height PNG): because the surface reaches every
// edge, adjacent road tiles merge into a continuous run whether the road turns,
// crosses, or dead-ends — no per-direction connection art needed. Base `r`,
// worn lighter `R` centre patches, and a few darker `n` gravel/crack flecks for
// texture. The outer ring is base `r` so runs seam cleanly in every direction.

import type { PixelGrid } from '../types';

export const road: PixelGrid = [
  'rrrrrrrrrrrrrrrr',
  'rrrrrrrrrrrrrrrr',
  'rrRrrrrrrrrrRrrr',
  'rrrrrrnrrrrrrrrr',
  'rrrrrRrrrrrRrrrr',
  'rrrrrrrrnrrrrrrr',
  'rrRrrrrrrrrrrRrr',
  'rrrrrrRrrrrrrrrr',
  'rrrrnrrrrrRrrrrr',
  'rrRrrrrrrrrrrnrr',
  'rrrrrRrrrrRrrrrr',
  'rrrrrrrrnrrrrrrr',
  'rrRrrrrrrrrrRrrr',
  'rrrrrrrrrrrrrrrr',
  'rrrrrrrrrrrrrrrr',
  'rrrrrrrrrrrrrrrr',
];
