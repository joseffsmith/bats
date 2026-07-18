// Pure-data guards for the 3×5 digit glyph atlas (Phase 3B) used by the on-board
// HP numeral and the capture-meter progress number. No canvas — the glyphs are
// authored data; canvas.ts bakes them. The bars: right shape, only ink/empty
// chars, non-empty, and every digit visually distinct from every other.

import { describe, expect, it } from 'vitest';
import {
  DIGIT_GLYPHS,
  DIGIT_CHARS,
  DIGIT_W,
  DIGIT_H,
  DIGIT_INK,
} from '../src/renderer/assets/pixel-art/digits';

describe('digits: structure', () => {
  it('covers 0–9', () => {
    expect(DIGIT_CHARS).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it.each(DIGIT_CHARS)('glyph %s is DIGIT_H rows of DIGIT_W ink/empty chars', (d) => {
    const glyph = DIGIT_GLYPHS[d]!;
    expect(glyph).toHaveLength(DIGIT_H);
    for (const row of glyph) {
      expect(row).toHaveLength(DIGIT_W);
      for (const ch of row) expect(ch === DIGIT_INK || ch === '.').toBe(true);
    }
  });

  it.each(DIGIT_CHARS)('glyph %s has ink pixels', (d) => {
    const ink = DIGIT_GLYPHS[d]!.join('').split('').filter((c) => c === DIGIT_INK).length;
    expect(ink).toBeGreaterThanOrEqual(4);
  });
});

describe('digits: distinct', () => {
  it('every glyph differs from every other', () => {
    const flat = DIGIT_CHARS.map((d) => DIGIT_GLYPHS[d]!.join(''));
    expect(new Set(flat).size).toBe(DIGIT_CHARS.length);
  });
});
