import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GanttRenderer } from '../../src/embed';
import { canvasMeasure, RIGHT_PAD } from '../../src/layout/gutterWidth';
import type { GanttDocument } from '../../src/types/document';

/**
 * SRS-LAY-053, the export half.
 *
 * The app's row panel was drawing names straight across the plot on a narrow
 * window, and so was this renderer — with a worse constant. The embed gutter
 * is 22% of the figure width clamped to [80, 180], so it is narrower than the
 * app's at every size, and nothing clips the group the names are drawn in.
 * Every exported SVG of a plan with real package names had its own bars
 * written over.
 *
 * Observed red before `truncateToGutter` reached this file: at a 600px figure
 * (132px of gutter) the name below was drawn at its full width.
 *
 * jsdom has no 2d canvas context, so `canvasMeasure` falls through to its
 * per-character estimate — the same estimate the renderer used to decide the
 * cut, which is what makes the arithmetic here checkable.
 */

const LONG = 'Safety mechanisms, E2E and watchdog';
const WIDTH = 600;
const GUTTER_W = Math.max(80, Math.min(180, Math.round(WIDTH * 0.22)));

const doc = (): GanttDocument => ({
  schemaVersion: 1,
  title: 'Export test',
  calendar: { scale: 'week', fiscalYearStart: 1, workingDays: [1, 2, 3, 4, 5], holidays: [] },
  rows: [
    { id: 'r1', label: LONG, groupId: null },
    { id: 'r2', label: 'Spec', groupId: null },
  ],
  tasks: [{ id: 't1', rowId: 'r1', label: 'Work', start: '2026-06-01', end: '2026-06-20' }],
  milestones: [],
  brackets: [],
  dependencies: [],
  markers: [],
  style: { theme: 'light', preset: 'default' },
});

const markup = () =>
  renderToStaticMarkup(
    createElement(GanttRenderer, { document: doc(), width: WIDTH, height: 300 }),
  );

/**
 * Each row-name <text>: what is drawn, and the <title> beside it — which is
 * there only when the name had to be cut, so that a name drawn in full does
 * not appear twice in the text tree.
 */
const drawnNames = (svg: string) =>
  [...svg.matchAll(/<text[^>]*font-size="11" font-weight="500"[^>]*>(.*?)<\/text>/g)].map((m) => {
    const title = m[1].match(/<title>(.*?)<\/title>/);
    return { drawn: m[1].replace(/<title>.*?<\/title>/, ''), title: title?.[1] ?? null };
  });

describe('an exported chart keeps its row names in the gutter (SRS-LAY-053)', () => {
  it('cuts a name too long for the gutter and keeps the whole one in a title', () => {
    const long = drawnNames(markup()).find((n) => n.title === LONG);
    expect(long, 'the long row name was not rendered at all').toBeDefined();
    expect(long!.drawn).not.toBe(LONG);
    expect(long!.drawn).toMatch(/…$/);
    expect(LONG.startsWith(long!.drawn.replace(/…$/, '').trim())).toBe(true);
  });

  it('leaves a name that fits exactly as it was written, and adds nothing to it', () => {
    const fits = drawnNames(markup()).find((n) => n.drawn === 'Spec');
    expect(fits, 'the short row name was not rendered at all').toBeDefined();
    // A <title> repeating a name already drawn in full is a second copy of it
    // in the text tree: a screen reader reads it twice, and a locator looking
    // for the name finds the invisible one first.
    expect(fits!.title, 'a name drawn in full carries a tooltip repeating it').toBeNull();
  });

  it('no drawn name is wider than the gutter it sits in', () => {
    const names = drawnNames(markup());
    expect(names.length, 'no row names were found to measure').toBeGreaterThan(1);
    for (const { drawn } of names) {
      const width = canvasMeasure(drawn, 11, false);
      expect(width, `"${drawn}" is ${Math.round(width)}px`).toBeLessThanOrEqual(GUTTER_W - 12 - RIGHT_PAD);
    }
  });
});
