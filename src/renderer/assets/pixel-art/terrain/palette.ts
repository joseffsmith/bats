// Fixed palette + neutral ramp for the hand-authored terrain tiles.
//
// Terrain grids are the same char-grid form as the unit sprites (see
// ../types.ts) but with three differences from the unit contract:
//
//   • FULL-BLEED — every cell is opaque. Tiles butt against their neighbours
//     with no gutter, so there is no '.' transparent cell (validateTerrainGrid
//     rejects it) and the bake needs no crop rect.
//   • its own colour set — greens / blues / warm earth / concrete, tuned to sit
//     with the current PNG board hue (plain ≈ #608020, sea ≈ #0060a0, cream
//     city walls ≈ #e0c080) so the map's colour-grade keeps reading the same.
//   • per-owner accents — the capturable tiles (city/hq/factory) carry a few
//     team-ramp cells (A/B/C/D) on the roof / banner / pad. They bake three
//     ways: player 0 (crimson) and player 1 (cobalt) resolve through
//     PLAYER_COLOURS[owner].ramp; the neutral tile resolves the *same* cells
//     through NEUTRAL_RAMP (steel greys) so an unowned building reads as
//     "no team" rather than a third colour.
//
// The team-ramp chars (A/B/C/D) and their meaning (shadow→highlight) are shared
// verbatim with the unit palette; everything else here is terrain-only.

/** Fixed, shared terrain colours. Chars must not collide with the team chars
 *  (A–D). Every cell a terrain grid uses must be one of these or a team char,
 *  or validateTerrainGrid rejects it. */
export const TERRAIN_PALETTE: Record<string, string> = {
  // ── Grass / open ground ──
  g: '#6f8a36', // grass base — the board's dominant green
  G: '#7d9640', // grass light — sparse top-left dapple
  v: '#5f7c30', // grass shadow — sparse dark fleck

  // ── Forest ──
  e: '#274420', // canopy darkest (shadow side / underside)
  f: '#375d2b', // canopy mid
  F: '#4d7a39', // canopy light (top-left catch)
  t: '#3a2917', // trunk brown

  // ── Road (warm tan) ──
  n: '#7a6035', // road dark — cracks / worn edge
  r: '#a6874d', // road base — the tan surface
  R: '#bd9f66', // road light — worn centre

  // ── Sea ──
  // Kept low-contrast on purpose: every sea cell bakes to the same tile, so a
  // bold fleck would repeat into a visible lattice across open water (see the
  // armada board). The deep/crest tones sit close to the mid base and the foam
  // is dim, so the surface mottles gently rather than stamping a grid.
  b: '#1e5788', // deep — subtle dark mottle
  s: '#256aa0', // mid — the dominant water tone
  c: '#3a7cb0', // crest / lit ripple — a hair above the base
  w: '#79aece', // foam fleck — dim, used very sparingly

  // ── Mountain rock ──
  k: '#55432f', // rock shadow (east face)
  m: '#86704e', // rock mid
  M: '#a68d69', // rock light (west face)
  o: '#eceae0', // snow cap

  // ── Buildings (concrete pad, walls, details) ──
  p: '#948a7f', // concrete pad base
  P: '#b2a89a', // concrete pad light
  q: '#625a4f', // concrete / trim shadow
  L: '#dccdac', // wall cream light
  y: '#c2b184', // wall cream mid
  x: '#33312a', // roof cap / door / dark slot
  u: '#f4d06a', // window — lit warm
  z: '#2e2b1f', // window — dark
  K: '#17130d', // outline — warm near-black
  Q: '#f2ead2', // warm white — sign / trim highlight
  W: '#d4a857', // gold accent — civic pip / warning stripe
} as const;

/** Team-ramp cells, dark→light. Resolved per-owner at bake (see canvas-palette
 *  PLAYER_COLOURS[owner].ramp), identical contract to the unit sprites. */
export const TERRAIN_TEAM_CHARS = ['A', 'B', 'C', 'D'] as const;

/** Steel-grey ramp the *neutral* variant of a capturable tile bakes its A–D
 *  accent cells through, so an unowned building reads as team-less rather than
 *  a third faction colour. Dark→light to mirror the team ramp's A/B/C/D. */
export const NEUTRAL_RAMP: readonly [string, string, string, string] = [
  '#565b62',
  '#797f88',
  '#9aa1aa',
  '#c4cbd3',
];

/** The set of every legal terrain cell char (fixed palette ∪ team chars). Note
 *  '.' is intentionally absent — terrain is full-bleed. */
export const TERRAIN_CHARS: ReadonlySet<string> = new Set([
  ...Object.keys(TERRAIN_PALETTE),
  ...TERRAIN_TEAM_CHARS,
]);

/** True for any char a terrain grid is allowed to contain. */
export function isKnownTerrainChar(ch: string): boolean {
  return TERRAIN_CHARS.has(ch);
}
