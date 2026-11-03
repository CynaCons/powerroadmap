import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every setting the chrome offers is also in the panel (SRS-SET-010).
 *
 * This reads source rather than a running app on purpose. The failure it exists
 * to catch is a new setting added to the command bar and nowhere else — which is
 * how the look settings came to live only inside a context that appears when
 * something is selected, and how the planner's complaint ("it's not matching")
 * started. That is a fact about which identifiers each file mentions, and a
 * rendered app cannot tell you about a control nobody added.
 *
 * It is a weak gate by construction and says so: a preference held somewhere
 * that is not one of these two files is invisible to it.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

const COMMAND_BAR = read('src/app/CommandBar.tsx');
const PANEL = read('src/app/SettingsPanel.tsx');

/**
 * The document-settings part of the bar, from its `DocumentGroup` to the helper
 * that follows it. Scoped, because the bar also holds tools, insert buttons and
 * the zoom — none of which are settings and none of which belong in a panel.
 */
function documentSettingsSource(): string {
  const start = COMMAND_BAR.indexOf('function DocumentGroup()');
  const end = COMMAND_BAR.indexOf('const DELIMITER_CHOICES');
  expect(start, 'DocumentGroup not found in CommandBar').toBeGreaterThan(-1);
  expect(end, 'DELIMITER_CHOICES not found in CommandBar').toBeGreaterThan(start);
  // `WorkingDays` is rendered by DocumentGroup but declared further down.
  const days = COMMAND_BAR.indexOf('function WorkingDays()');
  return COMMAND_BAR.slice(start, end) + COMMAND_BAR.slice(days, days + 1600);
}

/** Store setters a region calls, e.g. `setTheme`, `setWorkingDays`. */
function settersIn(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\bconst (set[A-Z]\w*) = useDocumentStore/g)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

/** Document operations a region sends, e.g. `set_grid_delimiter`. */
function opsIn(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/op: '(set_[a-z_]+)'/g)) found.add(match[1]);
  return [...found].sort();
}

describe('the panel holds every setting the chrome offers (SRS-SET-010)', () => {
  it('finds the settings the command bar writes, or fails loudly', () => {
    // The control for this whole file: if the extractor silently matched
    // nothing, every assertion below would pass over an empty set.
    const setters = settersIn(documentSettingsSource());
    expect(setters.length).toBeGreaterThanOrEqual(4);
    expect(setters).toContain('setTheme');
    expect(opsIn(documentSettingsSource())).toContain('set_grid_delimiter');
  });

  it('binds every store setter the command bar binds', () => {
    const missing = settersIn(documentSettingsSource()).filter((name) => !PANEL.includes(name));
    expect(
      missing,
      `settings reachable only from the command bar: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('sends every document operation the command bar sends', () => {
    const missing = opsIn(documentSettingsSource()).filter((op) => !PANEL.includes(`'${op}'`));
    expect(missing, `operations the panel cannot reach: ${missing.join(', ')}`).toEqual([]);
  });

  it('writes those settings as operations, the way an agent does', () => {
    // SRS-ABR-025: a person and an agent travel one path. A panel that called
    // `replaceDocument` would work and would quietly forfeit the all-or-nothing
    // batch and the single undo frame.
    expect(PANEL).toContain("applyBatch(ops, 'user')");
    expect(PANEL).not.toContain('replaceDocument');
  });

  it('leaves the command bar in place rather than moving the controls', () => {
    // The bar is the fast path during work; the panel is where things are
    // found. Both, not one — removing the bar's copy is a regression, not a
    // tidy-up, so the gate names it.
    expect(COMMAND_BAR).toContain('function DocumentGroup()');
    expect(settersIn(documentSettingsSource())).toContain('setFiscalYearStart');
  });
});
