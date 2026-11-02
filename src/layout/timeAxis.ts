import type { DateAnchor, GridDelimiter, ISODate, TimeScale } from '../types/document';
import {
  addDays,
  addMonths,
  formatISO,
  parseISO,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  diffDays,
  fiscalQuarterOf,
  isoWeekNumber,
} from '../utils/dates';
import { canvasMeasure, type MeasureText } from './gutterWidth';

export interface AxisTick {
  iso: ISODate;
  label: string;
  x: number;
  /**
   * This label states which year it is, so it outranks its neighbours when
   * two will not fit (SRS-TAX-025, SRS-TAX-026). Set by `withYears`.
   */
  emphasis?: boolean;
}

export interface AxisLevel {
  ticks: AxisTick[];
  height: number;
}

export interface AxisLayout {
  major: AxisLevel;
  minor: AxisLevel;
  micro?: AxisLevel;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dateToX(iso: ISODate, viewStart: ISODate, pxPerDay: number): number {
  return diffDays(viewStart, iso) * pxPerDay;
}

/**
 * The grid column a date falls in: where it starts, and how many days it runs.
 *
 * The column is whatever the roadmap's delimiter is drawing, so "the middle of
 * the column" means the middle of the week on a week grid and the middle of
 * the month on a month grid. With no delimiter the column is the day, which
 * is the finest thing the axis addresses.
 */
export function columnSpan(iso: ISODate, delimiter: GridDelimiter): { start: ISODate; days: number } {
  switch (delimiter) {
    case 'week': {
      const start = startOfWeek(iso);
      return { start, days: 7 };
    }
    case 'month': {
      const start = startOfMonth(iso);
      return { start, days: diffDays(start, addMonths(start, 1)) };
    }
    case 'quarter': {
      const start = startOfQuarter(iso);
      return { start, days: diffDays(start, addMonths(start, 3)) };
    }
    default:
      return { start: iso, days: 1 };
  }
}

/**
 * How far past its date a mark is drawn, in days (SRS-ELEM-070).
 *
 * Zero for `start` and for a mark that has never been given an anchor, so
 * every document written before the field renders exactly where it did.
 */
export function anchorOffsetDays(
  iso: ISODate,
  delimiter: GridDelimiter,
  anchor: DateAnchor | undefined,
): number {
  if (!anchor || anchor === 'start') return 0;
  const { start, days } = columnSpan(iso, delimiter);
  const fromColumnStart = anchor === 'middle' ? days / 2 : days;
  return diffDays(iso, start) + fromColumnStart;
}

/** `dateToX`, with the mark's place in its column taken into account. */
export function anchoredX(
  iso: ISODate,
  viewStart: ISODate,
  pxPerDay: number,
  delimiter: GridDelimiter,
  anchor: DateAnchor | undefined,
): number {
  return dateToX(iso, viewStart, pxPerDay) + anchorOffsetDays(iso, delimiter, anchor) * pxPerDay;
}

export function xToDate(x: number, viewStart: ISODate, pxPerDay: number): ISODate {
  return addDays(viewStart, Math.round(x / pxPerDay));
}

export function dateToXFractional(iso: ISODate, viewStart: ISODate, pxPerDay: number): number {
  return diffDays(viewStart, iso) * pxPerDay;
}

export function visibleEnd(viewStart: ISODate, pxPerDay: number, widthPx: number): ISODate {
  const days = Math.ceil(widthPx / pxPerDay) + 1;
  return addDays(viewStart, days);
}

/**
 * How each band is actually drawn, so collisions can be measured rather than
 * guessed. `TimeAxis` draws at exactly these sizes and these x offsets.
 */
const BAND_TYPE = {
  major: { fontPx: 15, bold: true, padX: 8, gap: 8 },
  minor: { fontPx: 11, bold: false, padX: 4, gap: 6 },
  micro: { fontPx: 10, bold: false, padX: 2, gap: 4 },
} as const;

/**
 * Blank the labels that will not fit beside the one before them
 * (SRS-TAX-026).
 *
 * `thinTicks` spaces the ticks on a fixed minimum — 60px for the month band —
 * and then `withYears` appends the year to some of them, which is 20px of text
 * the spacing never allowed for. The band shipped reading "Feb 2026Mar": a
 * 4px overlap at 1440px, 6.6px at 390px (post-release report, v2.34.1).
 *
 * Thinning can only run again with the finished text in hand, so it runs here,
 * on measured widths, after the years are on. Only the LABEL is dropped — the
 * tick riser stays, so the month division is still drawn where it falls and
 * only the name of it is given up.
 *
 * A label that states the year outranks a plain one, because a band of months
 * with no year is the defect SRS-TAX-025 exists to prevent. Two year-bearing
 * labels colliding would need a year to fit in ~70px, which no scale this axis
 * offers can produce; if it ever happens, both are kept. An overlap is a
 * blemish, and a view that cannot say which year it is showing is a bug.
 */
function dropCollidingLabels(
  level: AxisLevel,
  band: keyof typeof BAND_TYPE,
  measure: MeasureText,
): AxisLevel {
  const { fontPx, bold, padX, gap } = BAND_TYPE[band];
  const ticks = level.ticks.map((t) => ({ ...t }));
  let last: { tick: AxisTick; right: number } | null = null;

  for (const tick of ticks) {
    if (!tick.label) continue;
    const left = tick.x + padX;
    const right = left + measure(tick.label, fontPx, bold);

    if (last === null || left >= last.right + gap) {
      last = { tick, right };
      continue;
    }
    if (tick.emphasis && !last.tick.emphasis) {
      // Whatever stood here before was clear of the label we are dropping, and
      // this one starts no earlier, so it is clear of this one too.
      last.tick.label = '';
      last = { tick, right };
    } else if (tick.emphasis) {
      last = { tick, right };
    } else {
      tick.label = '';
    }
  }

  return { ticks, height: level.height };
}

function thinTicks(level: AxisLevel, minSpacingPx: number): AxisLevel {
  if (level.ticks.length <= 1) return level;
  const kept: AxisTick[] = [level.ticks[0]];
  for (let i = 1; i < level.ticks.length; i++) {
    if (level.ticks[i].x - kept[kept.length - 1].x >= minSpacingPx) {
      kept.push(level.ticks[i]);
    }
  }
  return { ticks: kept, height: level.height };
}

export function buildAxis(
  viewStart: ISODate,
  pxPerDay: number,
  widthPx: number,
  scale: TimeScale,
  fiscalYearStart: number,
  /** Injectable so the label thinning can be tested without a canvas. */
  measure: MeasureText = canvasMeasure,
): AxisLayout {
  const end = visibleEnd(viewStart, pxPerDay, widthPx);
  let result: AxisLayout;

  switch (scale) {
    case 'day':
      result = {
        major: monthTicks(viewStart, end, pxPerDay),
        minor: weekTicks(viewStart, end, pxPerDay),
        micro: dayTicks(viewStart, end, pxPerDay),
      };
      break;
    case 'week':
      result = {
        major: monthTicks(viewStart, end, pxPerDay),
        minor: weekTicks(viewStart, end, pxPerDay),
      };
      break;
    case 'month':
      result = {
        major: quarterTicks(viewStart, end, pxPerDay, fiscalYearStart),
        minor: monthTicks(viewStart, end, pxPerDay),
      };
      break;
    case 'quarter':
      result = {
        major: yearTicks(viewStart, end, pxPerDay, fiscalYearStart),
        minor: quarterTicks(viewStart, end, pxPerDay, fiscalYearStart),
      };
      break;
    case 'year':
      result = {
        major: yearTicks(viewStart, end, pxPerDay, fiscalYearStart),
        minor: yearTicks(viewStart, end, pxPerDay, fiscalYearStart),
      };
      break;
  }

  // Skip overlapping labels based on actual pxPerDay
  result.major = thinTicks(result.major, 60);
  result.minor = thinTicks(result.minor, 36);
  if (result.micro) {
    result.micro = thinTicks(result.micro, 16);
  }

  // The year goes on last, once we know which month ticks actually survive
  // and where they sit (SRS-TAX-025).
  if (scale === 'day' || scale === 'week') {
    result.major = withYears(result.major);
  } else if (scale === 'month') {
    result.minor = withYears(result.minor);
  }

  // And the labels are thinned again now that they are final, against their
  // measured widths rather than a fixed minimum (SRS-TAX-026).
  result.major = dropCollidingLabels(result.major, 'major', measure);
  result.minor = dropCollidingLabels(result.minor, 'minor', measure);
  if (result.micro) {
    result.micro = dropCollidingLabels(result.micro, 'micro', measure);
  }
  return result;
}

/**
 * Add the year to the month ticks that need it, and only those.
 *
 * Two rules, both about what a reader can actually see:
 *  - the first tick whose LABEL lands on screen carries the year, so the view
 *    always states which year it is. The leading tick is generated at the
 *    start of its month, which is usually off the left edge, and its label
 *    goes with it.
 *  - any tick whose year differs from the previous surviving one carries it,
 *    so the turn of the year is always marked even when thinning removed
 *    January itself. A two-year view at week scale otherwise read
 *    "Oct · Dec · Feb · Apr" with nothing to say which February.
 */
function withYears(level: AxisLevel): AxisLevel {
  // TimeAxis draws a major label at x + 8; anything further left is cut off.
  const LABEL_PAD = 8;
  let previousYear: number | null = null;
  let statedOnce = false;
  const ticks = level.ticks.map((t) => {
    const year = parseISO(t.iso).getUTCFullYear();
    const readable = t.x + LABEL_PAD >= 0;
    const turnsTheYear = previousYear !== null && year !== previousYear;
    const show = turnsTheYear || (readable && !statedOnce);
    previousYear = year;
    if (show) statedOnce = true;
    return show ? { ...t, label: `${t.label} ${year}`, emphasis: true } : t;
  });
  // Every tick is off the left edge — a view narrower than one month. State it
  // on the last one rather than nowhere.
  if (!statedOnce && ticks.length > 0) {
    const last = ticks[ticks.length - 1];
    ticks[ticks.length - 1] = {
      ...last,
      label: `${last.label} ${parseISO(last.iso).getUTCFullYear()}`,
      emphasis: true,
    };
  }
  return { ticks, height: level.height };
}

function dayTicks(start: ISODate, end: ISODate, pxPerDay: number): AxisLevel {
  const ticks: AxisTick[] = [];
  let cursor = start;
  while (parseISO(cursor) <= parseISO(end)) {
    const d = parseISO(cursor);
    ticks.push({ iso: cursor, label: String(d.getUTCDate()), x: dateToX(cursor, start, pxPerDay) });
    cursor = addDays(cursor, 1);
  }
  return { ticks, height: 20 };
}

function weekTicks(start: ISODate, end: ISODate, pxPerDay: number): AxisLevel {
  const ticks: AxisTick[] = [];
  let cursor = startOfWeek(start);
  while (parseISO(cursor) <= parseISO(end)) {
    ticks.push({
      iso: cursor,
      label: `W${isoWeekNumber(cursor)}`,
      x: dateToX(cursor, start, pxPerDay),
    });
    cursor = addDays(cursor, 7);
  }
  return { ticks, height: 20 };
}

function monthTicks(start: ISODate, end: ISODate, pxPerDay: number): AxisLevel {
  const ticks: AxisTick[] = [];
  let cursor = startOfMonth(start);
  while (parseISO(cursor) <= parseISO(end)) {
    const d = parseISO(cursor);
    // Month name only. Which ticks carry a year is decided in `withYears`,
    // AFTER thinning and with the real x positions — deciding it here chose
    // ticks that were then thinned away or drawn off the left edge, and a
    // week-scale chart could end up showing no year at all.
    ticks.push({
      iso: cursor,
      label: MONTH_NAMES[d.getUTCMonth()],
      x: dateToX(cursor, start, pxPerDay),
    });
    cursor = addMonths(cursor, 1);
  }
  return { ticks, height: 24 };
}

function quarterTicks(start: ISODate, end: ISODate, pxPerDay: number, fiscalYearStart: number): AxisLevel {
  const ticks: AxisTick[] = [];
  let cursor = startOfQuarter(start, fiscalYearStart);
  while (parseISO(cursor) <= parseISO(end)) {
    const { fy, q } = fiscalQuarterOf(cursor, fiscalYearStart);
    ticks.push({
      iso: cursor,
      label: `Q${q} ${fy}`,
      x: dateToX(cursor, start, pxPerDay),
    });
    cursor = addMonths(cursor, 3);
  }
  return { ticks, height: 24 };
}

function yearTicks(start: ISODate, end: ISODate, pxPerDay: number, fiscalYearStart: number): AxisLevel {
  const ticks: AxisTick[] = [];
  let cursor = startOfYear(start);
  while (parseISO(cursor) <= parseISO(end)) {
    const d = parseISO(cursor);
    let label = String(d.getUTCFullYear());
    if (fiscalYearStart !== 1) {
      label = `FY${d.getUTCFullYear()}`;
    }
    ticks.push({ iso: cursor, label, x: dateToX(cursor, start, pxPerDay) });
    const next = new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1));
    cursor = formatISO(next);
  }
  return { ticks, height: 28 };
}
