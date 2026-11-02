import type { Row } from '../types/document';

/**
 * How wide the row list wants to be, from the names actually in it
 * (SRS-LAY-050, SRS-LAY-051).
 *
 * The owner's complaint was "the left panel should auto-size to its text": a
 * fixed 200px truncated long package names and wasted half the panel on short
 * ones. The width here is a *default*, not a clamp — the moment the divider is
 * dragged the planner's number wins and this is never consulted again.
 *
 * The offsets below mirror `RowGutter`'s own `x` values rather than deriving
 * them: the two have to agree, and a shared constant in a third file would
 * have to be imported by the renderer purely to satisfy this measurement.
 * They are asserted together in tests/unit/gutterWidth.test.ts.
 */

/** Where each kind of name starts, matching RowGutter's text `x`. */
export const X_GROUP = 38;
export const X_CHILD = 30;
export const X_TOP = 12;
/** Clear space between the longest name and the divider. */
export const RIGHT_PAD = 16;

export const GUTTER_W_MIN = 120;
export const GUTTER_W_MAX = 520;

/** Measures one name as the chart will actually draw it. */
export type MeasureText = (text: string, fontPx: number, bold: boolean) => number;

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";

// Cached across calls: creating a canvas per keystroke of a rename is wasteful,
// and `undefined` here means "not tried yet" while `null` means "no 2d context
// in this host" — jsdom under vitest is the second case, and a width that
// silently became 0 there would make every test agree with every bug.
let ctx: CanvasRenderingContext2D | null | undefined;

export const canvasMeasure: MeasureText = (text, fontPx, bold) => {
  if (ctx === undefined) {
    try {
      ctx = document.createElement('canvas').getContext('2d');
    } catch {
      ctx = null;
    }
  }
  if (!ctx) {
    // 0.55em per character is the mean advance of this stack over mixed-case
    // Latin text. Wrong for "WWWW" and for "iiii", but it only has to keep a
    // contextless host inside the clamp.
    return text.length * fontPx * 0.55;
  }
  ctx.font = `${bold ? 600 : 400} ${fontPx}px ${FONT_STACK}`;
  return ctx.measureText(text).width;
};

export function gutterWidthFor(rows: Row[], measure: MeasureText = canvasMeasure): number {
  // The same visibility filter the layout engine applies. Computing it from
  // `doc.rows` instead of reading `layout.visibleRows` is deliberate: the
  // layout depends on the chart width, which depends on the gutter width, so
  // taking the rows from the layout would close a cycle.
  const collapsed = new Set(rows.filter((r) => r.collapsed).map((r) => r.id));
  const visible = rows.filter((r) => !r.groupId || !collapsed.has(r.groupId));
  const hasChildren = new Set(visible.map((r) => r.groupId).filter((id): id is string => !!id));

  let widest = 0;
  for (const row of visible) {
    const group = hasChildren.has(row.id);
    const x = group ? X_GROUP : row.groupId ? X_CHILD : X_TOP;
    const font = group ? 12 : 11;
    widest = Math.max(widest, x + measure(row.label, font, group) + RIGHT_PAD);
  }

  return Math.max(GUTTER_W_MIN, Math.min(GUTTER_W_MAX, Math.ceil(widest)));
}

/**
 * The name as it can actually be drawn in `available` px, with an ellipsis
 * when it has to be cut (SRS-LAY-053).
 *
 * The gutter is not always as wide as its names want: it is clamped to
 * `GUTTER_W_MIN` on a narrow window, and the divider can be dragged anywhere.
 * `RowGutter` drew the full name regardless, with nothing clipping it, so on a
 * 390px phone 28 of 39 names ran out of the gutter and across the plot — one
 * of them 97px into the bars it was supposed to label (post-release report,
 * v2.34.1).
 *
 * Measured with the same function and the same `RIGHT_PAD` as the auto-width
 * above, which gives the pair an invariant worth having: a gutter sized to its
 * own names never truncates. Text is only ever cut because the gutter is
 * narrower than the names asked for.
 */
export function truncateToGutter(
  text: string,
  available: number,
  fontPx: number,
  bold: boolean,
  measure: MeasureText = canvasMeasure,
): string {
  if (available <= 0) return '';
  if (measure(text, fontPx, bold) <= available) return text;

  const ellipsis = '…';
  if (measure(ellipsis, fontPx, bold) > available) return '';

  // Longest prefix that still fits with the ellipsis on it.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid).trimEnd() + ellipsis, fontPx, bold) <= available) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? ellipsis : text.slice(0, lo).trimEnd() + ellipsis;
}
