import { test, expect } from '@playwright/test';

/**
 * Covers SRS-ABR-019: every operation an agent can perform is reachable by a
 * person through the UI. These three were agent-only until 2026-10-23 — row
 * ordering did not exist at all, and sections and working days could be set
 * over the bridge but not by hand.
 */

async function openRowMenu(page: import('@playwright/test').Page, rowLabel: string) {
  // By the row's own group, not by `text=`: where the panel is narrower than
  // the name, the name is drawn cut and the whole one lives in a <title>
  // (SRS-LAY-053), which has no box to click. `hasText` reads the group's
  // text content, so it finds the row either way.
  const row = page.locator('[data-pp-kind="row"]').filter({ hasText: rowLabel }).first();
  const box = await row.boundingBox();
  if (!box) throw new Error(`row "${rowLabel}" not found in the gutter`);
  await page.mouse.click(box.x + 20, box.y + box.height / 2, { button: 'right' });
  return page.locator('[role="menu"], .context-menu').first();
}

test.describe('row operations are reachable by hand', () => {
  test('a row can be reordered from its own menu', async ({ page }) => {
    await page.goto('/');
    const before = await page.locator('[data-pp-kind="row"]').evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.ppId),
    );
    const menu = await openRowMenu(page, 'MCAL integration');
    await expect(menu).toContainText('Move down');
    await menu.getByText('Move down', { exact: true }).click();

    const after = await page.locator('[data-pp-kind="row"]').evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.ppId),
    );
    expect(after).not.toEqual(before);
    expect(after).toHaveLength(before.length);
  });

  test('a row can be moved into another section', async ({ page }) => {
    await page.goto('/');
    const menu = await openRowMenu(page, 'MCAL integration');
    // One entry now, with the sections behind it (SRS-EDIT-090). The menu used
    // to carry one `Move into "X"` per section, so its height grew with the
    // plan.
    await expect(menu).not.toContainText('Move into');
    const move = menu.getByRole('menuitem', { name: 'Move to section' });
    await expect(move).toBeVisible();
    await move.hover();
    const sub = menu.locator('[data-pp-submenu="move-to"]');
    await expect(sub).toBeVisible();
    // Its own section is not offered — that would be a no-op.
    await expect(sub).not.toContainText('Platform');
    await expect(sub).toContainText('Release');
  });

  test('working days are editable from the document context', async ({ page }) => {
    await page.goto('/');
    // Wait for the chart before driving the bar. Without this the click can
    // land before the app has hydrated, which made the test pass alone and
    // fail in a full parallel run.
    await page.locator('.chart-area svg').first().waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Document settings' }).click();
    const group = page.getByRole('group', { name: 'Working days' });
    await expect(group).toBeVisible();
    const saturday = group.getByRole('button').nth(5);
    await expect(saturday).toHaveAttribute('aria-pressed', 'false');
    await saturday.click();
    await expect(saturday).toHaveAttribute('aria-pressed', 'true');
  });
});
