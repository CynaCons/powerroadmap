/**
 * The one list of "chart look" options, read by both surfaces that offer them.
 *
 * Why this file exists (owner report 2026-11-04, "where can I set it? I don't
 * see where I can"): the row separator shipped in v2.37.0 into the Settings
 * dialog only. The right-hand panel's DOCUMENT section already carried every
 * other look setting — theme, overlap, delimiters, weekends — so the planner
 * looked there, found the four he knew and no fifth, and concluded the feature
 * had not shipped. It had; it was two clicks away behind a gear he had no
 * reason to open.
 *
 * The cause was structural, not an oversight: the two surfaces each kept their
 * own hand-written option lists (`THEMES` with `id` here and `value` there,
 * `DELIMITERS` against `DELIMITER_CHOICES`, "Quarter" against "Qtr"). Nothing
 * connected them, so adding a setting to one could never fail loudly in the
 * other. Shared values mean the next setting added here is added once.
 *
 * Labels may still differ by surface, because the panel is a 240px column and
 * the dialog is not — that is a typographic choice, not drift. `short` is what
 * the panel draws; `label` is what the dialog draws. The `ariaLabel` of each
 * group is identical on both surfaces on purpose: it is what the parity test
 * walks (tests/e2e/look-parity.spec.ts), and it is how a screen reader hears
 * the same setting named the same way wherever it is met.
 */
import {
  ROW_SEPARATOR_WIDTHS,
  type RowSeparator,
  type RowSeparatorScope,
} from '../types/document';

export type LookChoice<T> = {
  value: T;
  /** What the Settings dialog draws, where there is room for a sentence. */
  label: string;
  /** What the narrow side panel draws. Falls back to `label`. */
  short?: string;
  hint: string;
};

/**
 * What the panel draws for a choice, given the room it has.
 *
 * Structural rather than generic on purpose: the callers map over a mixed list
 * of separator styles, widths and scopes, and a `LookChoice<T>` signature makes
 * that union uninferable at the call site for no gain — the function only ever
 * reads the two strings.
 */
export function panelLabel(c: { label: string; short?: string }): string {
  return c.short ?? c.label;
}

export const ROW_SEPARATOR_CHOICES: LookChoice<RowSeparator>[] = [
  { value: 'none', label: 'None', hint: 'No rule between rows' },
  { value: 'solid', label: 'Line', hint: 'An unbroken rule' },
  { value: 'dashed', label: 'Dashed', hint: 'A broken rule' },
  { value: 'dotted', label: 'Dotted', hint: 'A rule of dots' },
];

export const ROW_SEPARATOR_WIDTH_CHOICES: LookChoice<number>[] =
  ROW_SEPARATOR_WIDTHS.map((w) => ({
    value: w,
    label: `${w}px`,
    hint: w === 1 ? 'A hairline' : `${w} pixels thick`,
  }));

/**
 * "Between sections" is the sentence; "Sections" is the column. Both name the
 * same thing — a rule above each section heading only — and the hint carries
 * the full sentence on the short one, so nothing is lost by narrowing it.
 */
export const ROW_SEPARATOR_SCOPE_CHOICES: LookChoice<RowSeparatorScope>[] = [
  { value: 'groups', label: 'Between sections', short: 'Sections', hint: 'A rule above each section heading only' },
  { value: 'all', label: 'Between every row', short: 'Every row', hint: 'A rule between every row in the plan' },
];

/**
 * Every look setting, named by the `aria-label` its control group carries.
 *
 * This is the contract the two surfaces are held to: a setting listed here is
 * reachable from the side panel AND from the Settings dialog. Adding a look
 * setting means adding it here, and the parity test then fails until both
 * surfaces offer it — which is the failure that did not happen in v2.37.0.
 */
export const LOOK_CONTROLS = [
  'Theme',
  'Bars on the same dates',
  'Grid delimiters',
  'Row separator',
  'Weekend display',
] as const;

export type LookControl = (typeof LOOK_CONTROLS)[number];
