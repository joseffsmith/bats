// Transport — a small naval troop launch (movementClass: sea, ferries one foot
// unit; see units.json). Read against the LANDER, the other ferry: the lander
// is a long, low, near-empty barge with its wheelhouse at the stern, while the
// transport is a stubby launch dominated by a tall CENTRED troop cabin with a
// lit window facing the bow (right). Team-colour hull low in the water with a
// foam wake (Q) at the waterline so it reads as a boat at a glance — it was
// previously drawn as a copter, which promised flight the unit doesn't have.
// Light top-left: cabin roof (D/C), hull shadow (A).

import type { PixelGrid } from '../types';

export const transport: PixelGrid = [
  '................',
  '................',
  '................',
  '.....KKKKK......',
  '.....KDDCK......',
  '.....KCBLK......',
  '.....KBBLK......',
  '..KKKKBBBKKKK...',
  '.KDCCBBBBBBBCK..',
  '.KCBBBBBBBBBBAK.',
  '.KABBBBBBBBBAAK.',
  '..KKAAAAAAAAKK..',
  '..QQ..QQQ..QQ...',
  '................',
  '................',
  '................',
];
