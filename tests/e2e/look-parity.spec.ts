import { test, expect, type Page } from '@playwright/test';

/**
 * Every chart-look setting is reachable from BOTH surfaces that offer them.
 *
 * This is the test that was missing. v2.37.0 added the row separator to the
 * Settings dialog and not to the side panel's DOCUMENT section, where its four
 * neighbours already lived. Nine tests covered the separator working; none
 * covered it being *found*, so the suite was green and the owner's verdict was
 * "where can I set it? I don't see where I can".
 *
 * The groups are matched by `aria-label`, which both surfaces deliberately
 * spell the same (src/app/lookChoices.ts, LOOK_CONTROLS). The visible labels
 * may differ — the panel is a 288px column and says "Delimiters" and
 * "Sections" where the dialog has room for "Grid delimiters" and "Between
 * sections" — and that is a typographic choice, not drift.
 *
 * Desktop only: below 1000px the panel docks to the bottom and the dialog
 * narrows to a tab strip, which is a different layout with its own specs.
 */

/** Named by aria-label, the one spelling both surfaces share. */
const LOOK_CONTROLS = [
  'Theme',
  'Bars on the same dates',
  'Grid delimiters',
  'Row separator',
  'Weekend display',
] as const;

/** The DOCUMENT section starts collapsed, and its body is not rendered until it opens. */
async function openDocumentSection(page: Page) {
  const theme = page.locator('aside.cmdbar [role="radiogroup"][aria-label="Theme"]');
  if ((await theme.count()) === 0) {
    await page.getByRole('button', { name: 'Document settings' }).click();
  }
  await expect(theme).toBeVisible();
}

test.describe('a look setting is reachable from both surfaces', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'two full-width surfaces; desktop only');
    await page.goto('/');
    await page.locator('.chart-area svg').first().waitFor({ state: 'visible' });
  });

  test('the side panel offers every one of them', async ({ page }) => {
    await openDocumentSection(page);
    for (const name of LOOK_CONTROLS) {
      await expect(
        page.locator(`aside.cmdbar [role="radiogroup"][aria-label="${name}"]`),
        `the panel has no control for "${name}"`,
      ).toHaveCount(1);
    }
  });

  test('the settings dialog offers every one of them', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings, about and updates' }).click();
    const dialog = page.locator('.settings-panel');
    await expect(dialog).toBeVisible();
    for (const name of LOOK_CONTROLS) {
      await expect(
        dialog.locator(`[role="radiogroup"][aria-label="${name}"]`),
        `the dialog has no control for "${name}"`,
      ).toHaveCount(1);
    }
  });

  test('the separator set from the panel redraws the chart (SRS-LAY-061)', async ({ page }) => {
    await openDocumentSection(page);

    // The control, so "it changed" below cannot pass against a chart that
    // never drew a rule in the first place.
    await expect(page.locator('[data-pp-rowsep="solid"]')).not.toHaveCount(0);

    await page.getByTestId('cmdbar-rowsep-dotted').click();
    await expect(page.locator('[data-pp-rowsep="dotted"]')).not.toHaveCount(0);
    await expect(page.locator('[data-pp-rowsep="solid"]')).toHaveCount(0);

    // Width and scope exist only once there is a line to apply them to, and
    // the panel gates them exactly as the dialog does.
    await page.getByTestId('cmdbar-rowsep-width-3').click();
    await expect(page.locator('[data-pp-rowsep]').first()).toHaveAttribute('stroke-width', '3');

    await page.getByTestId('cmdbar-rowsep-none').click();
    await expect(page.locator('[data-pp-rowsep]')).toHaveCount(0);
    await expect(page.getByTestId('cmdbar-rowsep-width-3')).toHaveCount(0);
  });

  test('the two surfaces show each other’s change at once (SRS-SET-011)', async ({ page }) => {
    await openDocumentSection(page);
    await page.getByTestId('cmdbar-rowsep-dashed').click();

    await page.getByRole('button', { name: 'Settings, about and updates' }).click();
    // Not a second copy of the state: the dialog reads the same store field,
    // so it must already be showing dashed without being told.
    await expect(page.getByTestId('settings-rowsep-dashed')).toBeChecked();
  });

  test('the palette finds the separator by the word a planner types', async ({ page }) => {
    // The search that should have rescued this setting returned nothing: the
    // palette carried no entry containing "separator" anywhere.
    await page.keyboard.press('Control+k');
    await page.keyboard.type('separator');
    await expect(page.getByText('Row separator: Dashed')).toBeVisible();
    await page.getByText('Row separator: Dashed').click();
    await expect(page.locator('[data-pp-rowsep="dashed"]')).not.toHaveCount(0);
  });
});
