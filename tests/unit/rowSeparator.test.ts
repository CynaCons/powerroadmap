import { describe, it, expect } from 'vitest';
import {
  rowSeparatorOf,
  rowSeparatorWidthOf,
  rowSeparatorScopeOf,
  ROW_SEPARATORS,
  ROW_SEPARATOR_WIDTHS,
  type StyleSettings,
} from '../../src/types/document';

const style = (patch: Partial<StyleSettings> = {}): StyleSettings => ({
  theme: 'light',
  preset: 'default',
  ...patch,
});

/** The rule between rows, and what a file written before it means (SRS-LAY-061). */
describe('the row separator (SRS-LAY-061)', () => {
  it('draws what the chart always drew when the plan says nothing', () => {
    // This is the load-bearing case: every plan in existence was written
    // without these three fields, and all of them must look unchanged.
    const s = style();
    expect(rowSeparatorOf(s)).toBe('solid');
    expect(rowSeparatorWidthOf(s)).toBe(1);
    expect(rowSeparatorScopeOf(s)).toBe('groups');
  });

  it('survives a style object that is missing entirely', () => {
    // The readers are called from a renderer that can run a frame ahead of a
    // document swap, so `undefined` reaching them is not hypothetical.
    expect(rowSeparatorOf(undefined)).toBe('solid');
    expect(rowSeparatorWidthOf(undefined)).toBe(1);
    expect(rowSeparatorScopeOf(undefined)).toBe('groups');
  });

  it('returns what the plan asked for', () => {
    for (const sep of ROW_SEPARATORS) {
      expect(rowSeparatorOf(style({ rowSeparator: sep }))).toBe(sep);
    }
    for (const w of ROW_SEPARATOR_WIDTHS) {
      expect(rowSeparatorWidthOf(style({ rowSeparatorWidth: w }))).toBe(w);
    }
    expect(rowSeparatorScopeOf(style({ rowSeparatorScope: 'all' }))).toBe('all');
  });

  it('clamps a width a file could carry but the picker never offers', () => {
    // A hand-edited file, or an agent, can put any number here. 0 is "none"
    // said twice and a negative width is an invalid SVG attribute, which is
    // how one bad input becomes a rule per row that the browser drops.
    expect(rowSeparatorWidthOf(style({ rowSeparatorWidth: 0 }))).toBe(1);
    expect(rowSeparatorWidthOf(style({ rowSeparatorWidth: -4 }))).toBe(1);
    expect(rowSeparatorWidthOf(style({ rowSeparatorWidth: 99 }))).toBe(4);
    expect(rowSeparatorWidthOf(style({ rowSeparatorWidth: 2.6 }))).toBe(3);
  });

  it('offers none as a style, so the rule can be turned off entirely', () => {
    expect(ROW_SEPARATORS).toContain('none');
    expect(rowSeparatorOf(style({ rowSeparator: 'none' }))).toBe('none');
  });
});
