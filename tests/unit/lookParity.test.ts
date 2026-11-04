import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  LOOK_CONTROLS,
  ROW_SEPARATOR_CHOICES,
  ROW_SEPARATOR_SCOPE_CHOICES,
  ROW_SEPARATOR_WIDTH_CHOICES,
  panelLabel,
} from '../../src/app/lookChoices';

const src = (p: string) => readFileSync(resolve(__dirname, '../../src', p), 'utf8');

/**
 * The guard against the v2.37.0 fault: a look setting added to one surface and
 * not the other (owner report, "where can I set it? I don't see where I can").
 *
 * It reads the source rather than the DOM on purpose. The e2e parity spec
 * drives both surfaces and is the real proof, but it needs a browser and runs
 * on one project; this runs in milliseconds on every unit pass, so the drift
 * is named the moment it is introduced rather than at the next full gate.
 */
describe('the chart-look settings reach both surfaces', () => {
  const panel = src('app/CommandBar.tsx');
  const dialog = src('app/SettingsPanel.tsx');

  it('names every look control on both surfaces', () => {
    for (const name of LOOK_CONTROLS) {
      expect(panel, `the side panel has no control labelled "${name}"`).toContain(`aria-label="${name}"`);
      expect(dialog, `the settings dialog has no control labelled "${name}"`).toContain(`ariaLabel="${name}"`);
    }
  });

  it('covers the settings the owner could not find', () => {
    // Named explicitly so a careless edit to LOOK_CONTROLS cannot quietly
    // shrink the contract back to the four that shipped reachable.
    expect(LOOK_CONTROLS).toContain('Row separator');
    expect(LOOK_CONTROLS.length).toBe(5);
  });

  it('draws both surfaces from one option list', () => {
    // The cause was two hand-written lists per setting. If either surface
    // grows its own separator constants again, this fails.
    for (const file of [panel, dialog]) {
      expect(file).toContain("from './lookChoices'");
      expect(file).not.toMatch(/const ROW_SEPARATOR_CHOICES/);
    }
  });
});

describe('the panel gets labels that fit its column', () => {
  /**
   * The panel is 288px wide; a control row has 251px of line, 241px once it
   * scrolls, and a two-button group sharing its line with a field label has
   * room for about 14 characters a button. "Between every row" is 17 and would
   * have pushed the group onto its own line or out of the column.
   */
  const PANEL_BUDGET = 14;

  it('keeps every panel label inside the budget', () => {
    const all = [...ROW_SEPARATOR_CHOICES, ...ROW_SEPARATOR_WIDTH_CHOICES, ...ROW_SEPARATOR_SCOPE_CHOICES];
    for (const c of all) {
      expect(panelLabel(c).length, `"${panelLabel(c)}" is too wide for the panel`).toBeLessThanOrEqual(PANEL_BUDGET);
    }
  });

  it('shortens only where the dialog label would not fit', () => {
    // The scope labels are the only ones that needed it, and the long form is
    // still what the dialog draws.
    expect(ROW_SEPARATOR_SCOPE_CHOICES.map((c) => c.label)).toEqual(['Between sections', 'Between every row']);
    expect(ROW_SEPARATOR_SCOPE_CHOICES.map(panelLabel)).toEqual(['Sections', 'Every row']);
    // A choice with no `short` falls back to its label, so the dialog and the
    // panel cannot disagree about what an option is called by accident.
    expect(ROW_SEPARATOR_CHOICES.every((c) => c.short === undefined)).toBe(true);
    expect(panelLabel(ROW_SEPARATOR_CHOICES[1])).toBe('Line');
  });

  it('keeps the hint when the label is shortened', () => {
    // "Sections" alone does not say what the rule is drawn between; the full
    // sentence has to survive somewhere the pointer can reach it.
    for (const c of ROW_SEPARATOR_SCOPE_CHOICES) {
      expect(c.hint.length).toBeGreaterThan(c.label.length);
    }
  });
});
