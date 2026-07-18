// 3×5 pixel digit glyphs (0–9) for the on-board numerals: the AW-style HP digit
// (canvas.ts drawUnit, ceil(hp/10) → 1–9) and the capture meter's progress
// number. Authored as data so they're diffable and validated without a canvas;
// canvas.ts bakes each glyph once into a tiny outlined canvas and blits it
// scaled with imageSmoothing off (no fillText — it blurs at these sizes).
//
// '#' is an ink pixel, '.' is empty. Every glyph is exactly DIGIT_H rows of
// DIGIT_W chars; the renderer wraps the ink in a 1px dark backing for contrast
// against any terrain.

export const DIGIT_W = 3;
export const DIGIT_H = 5;

/** Ink pixel char in a glyph row. */
export const DIGIT_INK = '#';

export const DIGIT_GLYPHS: Record<string, readonly string[]> = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '###', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '..#', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
} as const;

/** The ten digit chars, '0'–'9'. */
export const DIGIT_CHARS: readonly string[] = Object.keys(DIGIT_GLYPHS);
