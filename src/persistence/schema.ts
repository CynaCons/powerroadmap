import type { GanttDocument, GridDelimiter, WeekendDisplay } from '../types/document';
import { GRID_DELIMITERS, WEEKEND_DISPLAYS } from '../types/document';

export const SCHEMA_VERSION = 1 as const;

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Days in each month, by 1-based month number. February is decided below. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * A date, and a day that exists (SRS-PERS-041).
 *
 * This was the shape and nothing else — `/^\d{4}-\d{2}-\d{2}$/` — so
 * `2026-13-45` passed, the file opened, and the viewport went to NaN: no
 * calendar axis, no bars, nothing to click and no message. A document that
 * cannot be laid out has to be refused at the door, where the planner can be
 * told which field is wrong.
 *
 * The month length is arithmetic rather than `Date.UTC`, because `Date.UTC`
 * maps years 0-99 onto 1900-1999 and would quietly accept `0099-02-29`.
 */
function isISODate(v: unknown): v is string {
  if (!isString(v) || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const year = Number(v.slice(0, 4));
  const month = Number(v.slice(5, 7));
  const day = Number(v.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const longest = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day <= longest;
}

/**
 * Check one date field and say which one it was.
 *
 * The old loop folded every field of a task into `tasks[3] invalid`, so a
 * planner with an impossible date in a 200-row plan was told a row number and
 * nothing else. The message now carries the path and the offending value, which
 * is what you need to fix the file (SRS-PERS-041).
 */
function checkDate(v: unknown, where: string): void {
  if (isISODate(v)) return;
  if (isString(v) && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new SchemaError(`${where} is not a day that exists: ${v}`);
  }
  throw new SchemaError(`${where} must be a date as YYYY-MM-DD, not ${JSON.stringify(v)}`);
}

export function validateDocument(input: unknown): GanttDocument {
  if (!isObject(input)) throw new SchemaError('Document must be an object');
  const schemaVersion = (input as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== 1) {
    throw new SchemaError(`Unsupported schemaVersion: ${schemaVersion}`);
  }
  const title = (input as { title?: unknown }).title;
  if (!isString(title)) throw new SchemaError('title must be a string');

  const calendar = (input as { calendar?: unknown }).calendar;
  if (!isObject(calendar)) throw new SchemaError('calendar must be an object');
  const scale = calendar.scale;
  if (scale !== 'day' && scale !== 'week' && scale !== 'month' && scale !== 'quarter' && scale !== 'year') {
    throw new SchemaError(`Invalid scale: ${String(scale)}`);
  }
  const fiscalYearStart = calendar.fiscalYearStart;
  if (!isNumber(fiscalYearStart) || fiscalYearStart < 1 || fiscalYearStart > 12) {
    throw new SchemaError('fiscalYearStart must be 1..12');
  }
  const workingDays = calendar.workingDays;
  if (!Array.isArray(workingDays) || !workingDays.every((n) => isNumber(n) && n >= 0 && n <= 6)) {
    throw new SchemaError('workingDays must be an array of 0..6');
  }
  const holidays = calendar.holidays;
  if (!Array.isArray(holidays)) {
    throw new SchemaError('holidays must be an array of YYYY-MM-DD');
  }
  holidays.forEach((h, i) => checkDate(h, `calendar.holidays[${i}]`));
  // Both optional, because every roadmap written before 2026-10-29 lacks them
  // and must still open; the reader supplies the default (SRS-TAX-057).
  const gridDelimiter = calendar.gridDelimiter;
  if (gridDelimiter !== undefined && !GRID_DELIMITERS.includes(gridDelimiter as GridDelimiter)) {
    throw new SchemaError(`Invalid gridDelimiter: ${String(gridDelimiter)}`);
  }
  const weekendDisplay = calendar.weekendDisplay;
  if (weekendDisplay !== undefined && !WEEKEND_DISPLAYS.includes(weekendDisplay as WeekendDisplay)) {
    throw new SchemaError(`Invalid weekendDisplay: ${String(weekendDisplay)}`);
  }

  const rows = (input as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) throw new SchemaError('rows must be an array');
  rows.forEach((r, i) => {
    if (!isObject(r) || !isString(r.id) || !isString(r.label)) {
      throw new SchemaError(`rows[${i}] invalid`);
    }
    if (r.groupId !== null && r.groupId !== undefined && !isString(r.groupId)) {
      throw new SchemaError(`rows[${i}].groupId invalid`);
    }
  });

  const tasks = (input as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) throw new SchemaError('tasks must be an array');
  tasks.forEach((t, i) => {
    if (!isObject(t) || !isString(t.id) || !isString(t.rowId) || !isString(t.label)) {
      throw new SchemaError(`tasks[${i}] invalid`);
    }
    checkDate(t.start, `tasks[${i}].start`);
    checkDate(t.end, `tasks[${i}].end`);
    if (t.percentComplete !== undefined && (!isNumber(t.percentComplete) || t.percentComplete < 0 || t.percentComplete > 100)) {
      throw new SchemaError(`tasks[${i}].percentComplete out of range`);
    }
    if (t.notes !== undefined && !isString(t.notes)) {
      throw new SchemaError(`tasks[${i}].notes must be string`);
    }
  });

  const milestones = (input as { milestones?: unknown }).milestones;
  if (!Array.isArray(milestones)) throw new SchemaError('milestones must be an array');
  milestones.forEach((m, i) => {
    if (!isObject(m) || !isString(m.id) || !isString(m.rowId) || !isString(m.label)) {
      throw new SchemaError(`milestones[${i}] invalid`);
    }
    checkDate(m.date, `milestones[${i}].date`);
  });

  const brackets = (input as { brackets?: unknown }).brackets;
  if (!Array.isArray(brackets)) throw new SchemaError('brackets must be an array');
  brackets.forEach((b, i) => {
    if (!isObject(b) || !isString(b.id) || !isString(b.label) || !Array.isArray(b.rowIds)) {
      throw new SchemaError(`brackets[${i}] invalid`);
    }
    checkDate(b.start, `brackets[${i}].start`);
    checkDate(b.end, `brackets[${i}].end`);
  });

  const dependencies = (input as { dependencies?: unknown }).dependencies;
  if (!Array.isArray(dependencies)) throw new SchemaError('dependencies must be an array');
  dependencies.forEach((d, i) => {
    if (!isObject(d) || !isString(d.id) || !isString(d.from) || !isString(d.to) || !isString(d.type)) {
      throw new SchemaError(`dependencies[${i}] invalid`);
    }
  });

  const markers = (input as { markers?: unknown }).markers;
  if (!Array.isArray(markers)) throw new SchemaError('markers must be an array');
  markers.forEach((m, i) => {
    if (!isObject(m) || !isString(m.id) || !isString(m.type) || !isString(m.label)) {
      throw new SchemaError(`markers[${i}] invalid`);
    }
    checkDate(m.date, `markers[${i}].date`);
  });

  const style = (input as { style?: unknown }).style;
  if (!isObject(style) || !isString(style.theme) || !isString(style.preset)) {
    throw new SchemaError('style invalid');
  }
  if (style.allowOverlap !== undefined && typeof style.allowOverlap !== 'boolean') {
    throw new SchemaError('style.allowOverlap must be a boolean');
  }

  // Optional baseline
  const baseline = (input as { baseline?: unknown }).baseline;
  if (baseline !== undefined) {
    if (!isObject(baseline) || !Array.isArray(baseline.tasks)) {
      throw new SchemaError('baseline invalid');
    }
    checkDate(baseline.capturedAt, 'baseline.capturedAt');
    baseline.tasks.forEach((b, i) => {
      if (!isObject(b) || !isString(b.id)) {
        throw new SchemaError(`baseline.tasks[${i}] invalid`);
      }
      checkDate(b.start, `baseline.tasks[${i}].start`);
      checkDate(b.end, `baseline.tasks[${i}].end`);
    });
  }

  return input as unknown as GanttDocument;
}
