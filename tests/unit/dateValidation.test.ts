import { describe, it, expect } from 'vitest';
import { validateDocument, SchemaError } from '../../src/persistence/schema';
import type { GanttDocument } from '../../src/types/document';

/**
 * SRS-PERS-041 — a date has to be a day that exists.
 *
 * `isISODate` was a shape test and nothing else: `/^\d{4}-\d{2}-\d{2}$/`. So
 * `2026-13-45` passed `validateDocument`, the file opened, and the viewport
 * went to NaN — no calendar axis at all, no bars, nothing to click, and no
 * message. A document that cannot be laid out must be refused at the door,
 * where the planner can be told which field is wrong, rather than accepted and
 * then silently failing to render.
 */

const base = (): Record<string, unknown> => ({
  schemaVersion: 1,
  title: 'Dates',
  calendar: { scale: 'week', fiscalYearStart: 1, workingDays: [1, 2, 3, 4, 5], holidays: [] },
  rows: [{ id: 'r1', label: 'A', groupId: null }],
  tasks: [{ id: 't1', rowId: 'r1', label: 'T', start: '2026-03-01', end: '2026-03-10' }],
  milestones: [],
  brackets: [],
  dependencies: [],
  markers: [],
  style: { theme: 'light', preset: 'default' },
});

const withTaskDates = (start: string, end: string) => {
  const d = base();
  (d.tasks as Record<string, unknown>[])[0] = { id: 't1', rowId: 'r1', label: 'T', start, end };
  return d;
};

describe('a real date is accepted', () => {
  it('ordinary ones', () => {
    expect(() => validateDocument(withTaskDates('2026-01-31', '2026-12-31'))).not.toThrow();
  });

  it('the last day of every month', () => {
    const ends = ['01-31', '02-28', '03-31', '04-30', '05-31', '06-30', '07-31', '08-31', '09-30', '10-31', '11-30', '12-31'];
    for (const md of ends) {
      expect(() => validateDocument(withTaskDates(`2026-${md}`, `2026-${md}`)), `2026-${md}`).not.toThrow();
    }
  });

  it('29 February in a leap year, and the century rules', () => {
    expect(() => validateDocument(withTaskDates('2028-02-29', '2028-02-29'))).not.toThrow();
    expect(() => validateDocument(withTaskDates('2000-02-29', '2000-02-29'))).not.toThrow();
  });
});

describe('a date that is not a day is refused (SRS-PERS-041)', () => {
  const BAD: [string, string][] = [
    ['2026-13-45', 'the one that wedged the chart'],
    ['2026-13-01', 'month 13'],
    ['2026-00-10', 'month 0'],
    ['2026-01-32', 'day 32'],
    ['2026-01-00', 'day 0'],
    ['2026-02-30', '30 February'],
    ['2026-02-29', '29 February in a common year'],
    ['1900-02-29', '1900 is not a leap year'],
    ['2026-04-31', '31 April'],
    ['2026-06-31', '31 June'],
    ['2026-09-31', '31 September'],
    ['2026-11-31', '31 November'],
  ];

  for (const [date, why] of BAD) {
    it(`${date} — ${why}`, () => {
      expect(() => validateDocument(withTaskDates(date, '2026-03-10'))).toThrow(SchemaError);
    });
  }

  it('names the field, so the planner knows what to correct', () => {
    let message = '';
    try {
      validateDocument(withTaskDates('2026-13-45', '2026-03-10'));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('tasks[0]');
    expect(message, 'the message does not quote the date that is wrong').toContain('2026-13-45');
  });

  it('checks milestones, markers, brackets and holidays too', () => {
    const cases: [string, (d: Record<string, unknown>) => void][] = [
      ['milestones', (d) => { d.milestones = [{ id: 'm', rowId: 'r1', label: 'M', date: '2026-02-30' }]; }],
      ['markers', (d) => { d.markers = [{ id: 'k', type: 'deadline', label: 'K', date: '2026-02-30' }]; }],
      ['brackets', (d) => { d.brackets = [{ id: 'b', label: 'B', start: '2026-02-30', end: '2026-03-10', rowIds: ['r1'] }]; }],
      ['holidays', (d) => { (d.calendar as Record<string, unknown>).holidays = ['2026-02-30']; }],
    ];
    for (const [what, mutate] of cases) {
      const d = base();
      mutate(d);
      expect(() => validateDocument(d as unknown), `${what} accepted an impossible date`).toThrow(SchemaError);
    }
  });
});

describe('a refused document is refused whole', () => {
  it('leaves the input exactly as it found it', () => {
    // This read `got`, which the test itself set to null in both branches, so
    // it could only tell "threw" from "did not throw" - which the cases above
    // already assert for the same input. What is worth asserting is that
    // nothing half-applied escapes: the caller's object is untouched, so no
    // partially-validated document can reach the viewport.
    const d = withTaskDates('2026-13-45', '2026-03-10');
    const snapshot = JSON.stringify(d);
    expect(() => validateDocument(d)).toThrow(SchemaError);
    expect(JSON.stringify(d), 'validateDocument mutated the document it refused').toBe(snapshot);
  });

  it('refuses on a bad date however deep it sits', () => {
    // The loops are index-ordered, so a bad date in the last task is the case
    // a mis-scoped early return would miss.
    const d = base();
    d.tasks = [
      { id: 't1', rowId: 'r1', label: 'A', start: '2026-03-01', end: '2026-03-10' },
      { id: 't2', rowId: 'r1', label: 'B', start: '2026-03-01', end: '2026-03-10' },
      { id: 't3', rowId: 'r1', label: 'C', start: '2026-03-01', end: '2026-02-30' },
    ];
    let message = '';
    try {
      validateDocument(d as unknown);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('tasks[2].end');
    expect(message).toContain('2026-02-30');
  });

  it('hands a valid document straight back - the control', () => {
    // Without this, "always throw" would satisfy everything above.
    const d = withTaskDates('2026-03-01', '2026-03-10');
    const out: GanttDocument = validateDocument(d);
    expect(out).toBe(d as unknown as GanttDocument);
  });
});
