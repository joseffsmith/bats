// Fixed palette + team-ramp contract for the hand-authored unit sprites.
//
// A sprite grid (see `types.ts`) is a field of single-char cells. At bake time
// every char resolves to an RGBA colour through one of three routes:
//
//   '.'            → transparent (the sprite sits inside a tile; empty cells
//                    show the terrain behind it).
//   'A' 'B' 'C' 'D'→ the *team ramp*, resolved per-player at bake so the same
//                    grid renders crimson for p0 and cobalt for p1. A=shadow,
//                    B=base, C=light, D=highlight (see canvas-palette.ts).
//   everything else→ FIXED_PALETTE below — shared, player-independent colours
//                    (outline, steel, glass, tracks, exhaust, gold).
//
// Hue discipline: the whole game palette is warm and low-key (bg #14110d, gold
// #d4a857 — see index.html :root). The steel/gunmetal stops are nudged a touch
// warm (a hair of brown in the greys) so units sit in that world rather than
// reading as cold sci-fi chrome. Team ramps stay saturated — Advance-Wars-style
// the *body* carries the colour, and these neutrals are only accents.

/** RGBA tuple, 0–255. Alpha is 255 for every fixed colour ('.' is the only
 *  transparent cell and it never reaches the palette). */
export type Rgba = readonly [number, number, number, number];

/** Team-ramp cell chars, dark→light. Resolved per-player at bake time. */
export const TEAM_CHARS = ['A', 'B', 'C', 'D'] as const;
export type TeamChar = (typeof TEAM_CHARS)[number];

/** The transparent cell. */
export const TRANSPARENT = '.';

// Fixed, shared colours. Chars are mnemonic-ish but arbitrary; the only hard
// rule is they must not collide with the team chars (A–D) or '.'.
//
// Keep this list tight (~16). Every char a grid uses must appear here (or be a
// team char / '.') or `validateGrid` rejects the sprite.
export const FIXED_PALETTE: Record<string, string> = {
  K: '#1a140f', // outline — warm near-black, wraps every silhouette
  E: '#2b3138', // gunmetal — darkest steel (barrels, shadowed hull steel)
  F: '#48505a', // gunmetal mid
  G: '#6f7784', // steel — the neutral body-metal midtone
  H: '#9aa4b2', // steel light
  I: '#d0d7e0', // steel highlight — top-left catch on metal
  J: '#173a4d', // glass/canopy — shadowed teal
  L: '#4691ad', // glass/canopy — lit teal-cyan (aircraft canopies, screens)
  M: '#2c1f13', // track/wood — dark brown (tank tracks, tyres, deck timber)
  N: '#573b22', // track/wood — mid brown
  P: '#8a6636', // track/wood light / sand — worn edges, wheels' hubs
  Q: '#f4ecd6', // warm white — brightest highlight, muzzle sparks, foam
  R: '#585860', // rotor/prop grey — thin spinning parts read as neutral
  S: '#221c15', // exhaust / soot — near-black warm, engine ports & scorch
  W: '#d4a857', // gold accent — headlights, insignia pips, warning stripes
} as const;

/** Parse `#rrggbb` → an opaque RGBA tuple. */
export function hexToRgba(hex: string): Rgba {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return [r, g, b, 255];
}

/** The set of every legal non-transparent, non-team char. */
export const FIXED_CHARS: ReadonlySet<string> = new Set(Object.keys(FIXED_PALETTE));

/** True for any char a grid is allowed to contain. */
export function isKnownChar(ch: string): boolean {
  return ch === TRANSPARENT || (TEAM_CHARS as readonly string[]).includes(ch) || FIXED_CHARS.has(ch);
}
