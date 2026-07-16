// Shared types for the hand-authored pixel-art unit sprites.
//
// A `PixelGrid` is the raw source form an artist edits: 16 rows of 16
// single-character cells. Each char is looked up at bake time — see
// `palette.ts` for the fixed palette and the A/B/C/D team-ramp contract, and
// `../../sprites.ts` for the char→RGBA rasteriser. Keeping the authored form a
// plain `string[]` means the art is diffable in review and testable without a
// canvas (validators in `validate.ts` operate on the grid directly).

/** 16 strings, each exactly 16 chars. Row 0 is the top; col 0 is the left. */
export type PixelGrid = string[];

/** Every sprite is authored on a 16×16 field (scaled to the tile at draw). */
export const GRID_SIZE = 16;
