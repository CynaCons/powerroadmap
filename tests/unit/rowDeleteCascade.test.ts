import { describe, it, expect, beforeEach } from 'vitest';
import { useDocumentStore } from '../../src/stores/documentStore';
import { applyOps } from '../../src/stores/docOps';
import type { GanttDocument } from '../../src/types/document';

/**
 * SRS-ABR-019 — a user action and an agent action must not diverge.
 *
 * `documentStore.deleteRow` hand-rolled its cascade and dropped the row, its
 * tasks and its milestones — but not the dependencies those tasks were part
 * of. The `delete_row` op the bridge uses has done it correctly all along.
 * So deleting a row from the context menu left records pointing at tasks that
 * no longer existed (measured: tasks 33 → 32 with `dep-arch-sw` surviving, its
 * `from` task gone), while the same deletion through the bridge did not.
 *
 * The test is written as the general property rather than as the one symptom:
 * whatever `deleteRow` does, it must do what `delete_row` does.
 */

const doc = (): GanttDocument => ({
  schemaVersion: 1,
  title: 'Cascade',
  calendar: { scale: 'week', fiscalYearStart: 1, workingDays: [1, 2, 3, 4, 5], holidays: [] },
  rows: [
    { id: 'row-a', label: 'A', groupId: null },
    { id: 'row-b', label: 'B', groupId: null },
  ],
  tasks: [
    { id: 't-a1', rowId: 'row-a', label: 'A1', start: '2026-03-01', end: '2026-03-10' },
    { id: 't-a2', rowId: 'row-a', label: 'A2', start: '2026-03-11', end: '2026-03-20' },
    { id: 't-b1', rowId: 'row-b', label: 'B1', start: '2026-03-21', end: '2026-03-30' },
  ],
  milestones: [{ id: 'ms-a', rowId: 'row-a', label: 'A done', date: '2026-03-20' }],
  brackets: [],
  dependencies: [
    { id: 'dep-within', from: 't-a1', to: 't-a2', type: 'finish-to-start' },
    { id: 'dep-across', from: 't-a2', to: 't-b1', type: 'finish-to-start' },
    { id: 'dep-elsewhere', from: 't-b1', to: 't-b1', type: 'finish-to-start' },
  ],
  markers: [],
  style: { theme: 'light', preset: 'default' },
});

/** Ids a dependency may legally mention: the tasks that still exist. */
const dangling = (d: GanttDocument) => {
  const alive = new Set(d.tasks.map((t) => t.id));
  return d.dependencies.filter((dep) => !alive.has(dep.from) || !alive.has(dep.to)).map((dep) => dep.id);
};

beforeEach(() => {
  useDocumentStore.getState().setDocument(doc());
});

describe('deleting a row takes its dependencies with it', () => {
  it('leaves nothing pointing at a task that is gone', () => {
    const before = dangling(useDocumentStore.getState().doc);
    expect(before, 'the fixture already contains a dangling dependency').toEqual([]);

    useDocumentStore.getState().deleteRow('row-a');
    const after = useDocumentStore.getState().doc;

    expect(after.rows.map((r) => r.id)).toEqual(['row-b']);
    expect(after.tasks.map((t) => t.id)).toEqual(['t-b1']);
    expect(after.milestones).toEqual([]);
    expect(
      dangling(after),
      `${dangling(after).join(', ')} still point at tasks that were deleted with the row`,
    ).toEqual([]);
  });

  it('keeps the dependencies that are still whole', () => {
    // Without this, "delete every dependency" would pass the test above.
    useDocumentStore.getState().deleteRow('row-a');
    expect(useDocumentStore.getState().doc.dependencies.map((d) => d.id)).toEqual(['dep-elsewhere']);
  });

  it('does exactly what the bridge does, which is the point (SRS-ABR-019)', () => {
    useDocumentStore.getState().deleteRow('row-a');
    const byHand = useDocumentStore.getState().doc;
    const byAgent = applyOps(doc(), [{ op: 'delete_row', id: 'row-a' }]);

    // Compare the document, not the bookkeeping the store adds around it.
    const shape = (d: GanttDocument) => ({
      rows: d.rows, tasks: d.tasks, milestones: d.milestones,
      brackets: d.brackets, dependencies: d.dependencies, markers: d.markers,
    });
    expect(shape(byHand)).toEqual(shape(byAgent));
  });

  it('and deleting a single task already did — so the instrument works', () => {
    useDocumentStore.getState().deleteTask('t-a2');
    const after = useDocumentStore.getState().doc;
    expect(after.dependencies.map((d) => d.id)).toEqual(['dep-elsewhere']);
    expect(dangling(after)).toEqual([]);
  });

  it('one row deletion is one undo step', () => {
    const before = useDocumentStore.getState().doc.rows.length;
    useDocumentStore.getState().deleteRow('row-a');
    expect(useDocumentStore.getState().doc.rows.length).toBe(before - 1);
    useDocumentStore.getState().undo();
    const back = useDocumentStore.getState().doc;
    expect(back.rows.length, 'one undo did not bring the row back').toBe(before);
    expect(back.dependencies.map((d) => d.id).sort()).toEqual(['dep-across', 'dep-elsewhere', 'dep-within']);
  });
});
