import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  gutterWidthFor,
  truncateToGutter,
  GUTTER_W_MIN,
  GUTTER_W_MAX,
  X_GROUP,
  X_TOP,
  RIGHT_PAD,
} from '../../src/layout/gutterWidth';
import type { Row } from '../../src/types/document';

/**
 * SRS-LAY-050, SRS-LAY-051 — the row panel sizes itself to its own names.
 *
 * The width was `ROW_GUTTER_W_BASE = 200` whatever was in the panel, so a long
 * package name was cut off mid-word and a plan of short names spent a quarter
 * of the window on empty panel. Owner report 2026-10-29: "the left panel
 * should auto-size to its text".
 *
 * Observed red on 79ccbdb: `src/layout/gutterWidth.ts` did not exist and the
 * width was a module constant with no input, so every case below failed on
 * import.
 *
 * jsdom has no 2d canvas context, so `canvasMeasure` falls through to its
 * per-character estimate here. These cases are therefore about the *rule* —
 * longer names mean a wider panel, depth costs indent, the clamp holds — not
 * about exact pixel advances, which only a real browser can give.
 */

const row = (id: string, label: string, groupId: string | null = null, collapsed?: boolean): Row => ({
  id,
  label,
  groupId,
  ...(collapsed === undefined ? {} : { collapsed }),
});

/** A measure with a known answer, so the arithmetic is checkable. */
const flat = (text: string) => text.length * 10;
const measure = (text: string) => flat(text);

describe('the row panel measures its own names (SRS-LAY-050)', () => {
  it('grows with the longest name', () => {
    const short = gutterWidthFor([row('r1', 'Spec')], measure);
    const long = gutterWidthFor([row('r1', 'Spec'), row('r2', 'Qualification campaign')], measure);
    expect(long).toBeGreaterThan(short);
  });

  it('places a top-level name at its own indent plus padding', () => {
    // x=12 for a top-level row, 16px of right padding.
    expect(gutterWidthFor([row('r1', 'abcdefghijklmnop')], measure)).toBe(12 + 160 + 16);
  });

  it('charges a child row for its indent', () => {
    const parent = row('g1', 'Phase');
    const child = row('r1', 'abcdefghij', 'g1');
    // x=30 for a child, and 'Phase' under x=38 at bold 12 is the shorter of the two.
    expect(gutterWidthFor([parent, child], measure)).toBe(30 + 100 + 16);
  });

  it('ignores the names of rows a collapsed group is hiding', () => {
    const rows = [
      row('g1', 'Phase', null, true),
      row('r1', 'a name far longer than the header', 'g1'),
    ];
    const collapsed = gutterWidthFor(rows, measure);
    const open = gutterWidthFor([row('g1', 'Phase'), rows[1]], measure);
    expect(collapsed).toBeLessThan(open);
    // Only the header is left to measure: x=38 for a group, 'Phase' is 5 chars.
    expect(collapsed).toBe(GUTTER_W_MIN);
  });

  it('never leaves the usable range, however long or short the names', () => {
    expect(gutterWidthFor([row('r1', 'x')], measure)).toBe(GUTTER_W_MIN);
    expect(gutterWidthFor([row('r1', 'y'.repeat(500))], measure)).toBe(GUTTER_W_MAX);
    expect(gutterWidthFor([], measure)).toBe(GUTTER_W_MIN);
  });

  it('agrees with the x offsets RowGutter actually draws', () => {
    // The two files used to carry the offsets separately, and this test read
    // both sources to catch them drifting apart. They share the constants now,
    // so there is nothing left to drift — what this guards is that the
    // renderer still takes them from here rather than going back to literals.
    const gutter = readFileSync('src/renderer/RowGutter.tsx', 'utf8');
    expect(gutter).toContain("from '../layout/gutterWidth'");
    expect(gutter).toContain('x={X_GROUP}');
    expect(gutter).toContain('x={row.groupId ? X_CHILD : X_TOP}');
    const widths = readFileSync('src/layout/gutterWidth.ts', 'utf8');
    expect(widths).toContain('X_GROUP = 38');
    expect(widths).toContain('X_CHILD = 30');
    expect(widths).toContain('X_TOP = 12');
  });
});

describe('a name is cut to the panel it has to fit (SRS-LAY-053)', () => {
  // `measure` above is 10px a character, so the arithmetic is checkable.
  it('leaves a name that fits exactly as it is', () => {
    expect(truncateToGutter('Spec', 40, 11, false, measure)).toBe('Spec');
    expect(truncateToGutter('Spec', 1000, 11, false, measure)).toBe('Spec');
  });

  it('cuts a name that does not, and says so with an ellipsis', () => {
    const cut = truncateToGutter('Qualification', 60, 11, false, measure);
    expect(cut).toBe('Quali…');
    expect(measure(cut)).toBeLessThanOrEqual(60);
  });

  it('never returns something wider than it was given, at any width', () => {
    const name = 'Safety mechanisms, E2E and watchdog';
    for (let available = 0; available <= 400; available += 7) {
      const cut = truncateToGutter(name, available, 11, false, measure);
      expect(measure(cut), `"${cut}" at ${available}px`).toBeLessThanOrEqual(available);
    }
  });

  it('gives up rather than show a lone ellipsis-sized sliver of nothing', () => {
    expect(truncateToGutter('Qualification', 5, 11, false, measure)).toBe('');
    expect(truncateToGutter('Qualification', 0, 11, false, measure)).toBe('');
    expect(truncateToGutter('Qualification', -20, 11, false, measure)).toBe('');
  });

  it('does not cut a name in a panel sized to hold it (SRS-LAY-050)', () => {
    // The invariant the two functions share: the auto width includes the same
    // RIGHT_PAD this one keeps clear, so auto-sizing and truncation agree.
    for (const label of ['Spec', 'Qualification campaign', 'Safety mechanisms, E2E and watchdog']) {
      const width = gutterWidthFor([row('r1', label)], measure);
      expect(truncateToGutter(label, width - X_TOP - RIGHT_PAD, 11, false, measure)).toBe(label);
    }
  });

  it('holds for a group name too, at its own deeper indent', () => {
    const label = 'Platform — BSW and MCAL';
    const width = gutterWidthFor([row('g1', label), row('r1', 'child', 'g1')], measure);
    expect(truncateToGutter(label, width - X_GROUP - RIGHT_PAD, 12, true, measure)).toBe(label);
  });
});

describe("a width the planner chose is not revised (SRS-LAY-051)", () => {
  it('holds the drag behind a nullable state, not behind the measured width', () => {
    // The measured width is a default, so the state has to be able to say
    // "nobody has chosen": a `number` initialised to the auto width could not
    // tell a stored 200 from a measured 200, and the panel would stop
    // following its names the first time they happened to agree.
    const chart = readFileSync('src/app/ChartArea.tsx', 'utf8');
    expect(chart).toContain('useState<number | null>');
    expect(chart).toContain('gutterW ?? autoGutterW');
  });

  it('does not store a width when no drag ever moved', () => {
    const chart = readFileSync('src/app/ChartArea.tsx', 'utf8');
    expect(chart).toContain('if (gutterW !== null)');
  });
});
