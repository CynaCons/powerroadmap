import { describe, it, expect } from 'vitest';
import { dropIndex } from '../../src/renderer/RowGutter';
import { applyOps } from '../../src/stores/docOps';
import type { GanttDocument, Row } from '../../src/types/document';

const row = (id: string, groupId: string | null = null): Row => ({ id, label: id, groupId });

/**
 * A plan with one section holding two rows:
 *   0 alpha
 *   1 sec        <- a section
 *   2   s-one    (child of sec)
 *   3   s-two    (child of sec)
 *   4 omega
 */
const ROWS: Row[] = [
  row('alpha'),
  row('sec'),
  row('s-one', 'sec'),
  row('s-two', 'sec'),
  row('omega'),
];

const doc = (rows: Row[]): GanttDocument => ({
  schemaVersion: 1,
  title: 'reorder',
  calendar: { scale: 'month', fiscalYearStart: 1, workingDays: [1, 2, 3, 4, 5], holidays: [] },
  rows,
  tasks: [],
  milestones: [],
  brackets: [],
  dependencies: [],
  markers: [],
  style: { theme: 'light', preset: 'default' },
});

/** The order `move_row` ends up with, which is the only thing a planner sees. */
const orderAfter = (id: string, boundary: number, rows: Row[] = ROWS): string[] | null => {
  const to = dropIndex(rows, rows, id, boundary);
  if (to === null) return null;
  return applyOps(doc(rows), [{ op: 'move_row', id, toIndex: to }]).rows.map((r) => r.id);
};

describe('reordering a row by dragging it (SRS-EDIT-091)', () => {
  it('moves a plain row to the top', () => {
    expect(orderAfter('omega', 0)).toEqual(['omega', 'alpha', 'sec', 's-one', 's-two']);
  });

  it('moves a plain row to the very end', () => {
    // Boundary === visible.length is "past the last row", not an off-by-one.
    expect(orderAfter('alpha', 5)).toEqual(['sec', 's-one', 's-two', 'omega', 'alpha']);
  });

  it('carries a section’s own rows with it', () => {
    // The owner asked to drag "the rows as a whole". A section that left its
    // children behind would silently reparent two rows into another stream.
    expect(orderAfter('sec', 0)).toEqual(['sec', 's-one', 's-two', 'alpha', 'omega']);
  });

  it('refuses to drop a section inside itself', () => {
    // Boundaries 2 and 3 are the section's own children: the operation would
    // be asked to insert a run of rows into the hole they just left.
    expect(dropIndex(ROWS, ROWS, 'sec', 2)).toBeNull();
    expect(dropIndex(ROWS, ROWS, 'sec', 3)).toBeNull();
    // The control: just past its last child IS a legal drop, so the rule above
    // is about the children and not about refusing every nearby boundary.
    expect(dropIndex(ROWS, ROWS, 'sec', 4)).not.toBeNull();
  });

  it('treats a drop onto the row’s own slot as nothing to do', () => {
    expect(dropIndex(ROWS, ROWS, 'alpha', 0)).toBeNull();
  });

  it('indexes into the rows that remain, not into the list on screen', () => {
    // This is the arithmetic the whole feature turns on. Dropping `alpha`
    // before `omega`: omega sits at 4 on screen, but at 3 once alpha is lifted
    // out. Returning 4 here would put alpha after omega — one row too far, in
    // the direction nobody notices until the plan is wrong.
    expect(dropIndex(ROWS, ROWS, 'alpha', 4)).toBe(3);
    expect(orderAfter('alpha', 4)).toEqual(['sec', 's-one', 's-two', 'alpha', 'omega']);
  });

  it('lands where the planner dropped it when the list is partly collapsed', () => {
    // The gutter only draws VISIBLE rows, so the boundary is an index into a
    // shorter list than the document's. Reading it against the document would
    // put the row somewhere nobody pointed at.
    const visible: Row[] = [row('alpha'), row('sec'), row('omega')];
    expect(dropIndex(ROWS, visible, 'omega', 1)).toBe(1);
    const moved = applyOps(doc(ROWS), [{ op: 'move_row', id: 'omega', toIndex: 1 }]);
    expect(moved.rows.map((r) => r.id)).toEqual(['alpha', 'omega', 'sec', 's-one', 's-two']);
  });
});
