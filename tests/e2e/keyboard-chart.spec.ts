import { test, expect, type Page } from '@playwright/test';

/**
 * SRS-EDIT-086 — the chart is reachable from the keyboard.
 *
 * Before this, 48 elements were focusable: 6 in the header, 40 in the side
 * panel, and 0 in the chart. The chart `<svg>` had no `role`, no `aria-label`
 * and no `tabindex`. Every editing shortcut the app documents — F2 to rename,
 * Del to delete, Enter for details, the arrow nudges — acts on *the
 * selection*, and the selection could only be made with a pointer. So the
 * whole documented keyboard was unreachable without a mouse, and the chart the
 * planner edits had no name while the picture it exports already did.
 */

const ready = async (page: Page) => {
  await page.goto('/');
  await page.locator('.chart-area svg').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('.task-bar-body').length > 0);
  await page.waitForTimeout(800);
};

const selectionCount = (page: Page) =>
  page.evaluate(() => {
    const m = (document.querySelector('.app-status')?.textContent ?? '').match(/(\d+)\s+selected/);
    return m ? Number(m[1]) : null;
  });

test.describe('the chart answers the keyboard (SRS-EDIT-086)', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 900, 'needs a desktop chart');

  test('the chart is a tab stop, and it has a name', async ({ page }) => {
    await ready(page);
    const svg = page.locator('.chart-area svg').first();
    await expect(svg).toHaveAttribute('tabindex', '0');
    const role = await svg.getAttribute('role');
    expect(role, 'the chart has no role').toBeTruthy();
    // role="img" would make every child presentational — the opposite of what
    // an editable chart needs.
    expect(role).not.toBe('img');
    const name = await svg.getAttribute('aria-label');
    expect(name?.length ?? 0, 'the chart has no accessible name').toBeGreaterThan(4);
  });

  test('tabbing from the header reaches the chart before the side panel', async ({ page }) => {
    await ready(page);
    const order = await page.evaluate(() => {
      const focusables = [...document.querySelectorAll<HTMLElement>(
        'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])',
      )].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !(el as HTMLButtonElement).disabled;
      });
      return focusables.map((el) =>
        el.closest('.app-header') ? 'header' : el.closest('.chart-area') ? 'chart' : el.closest('.cmdbar') ? 'panel' : 'other',
      );
    });
    expect(order.filter((r) => r === 'chart').length, 'nothing in the chart is focusable').toBeGreaterThan(0);
    const firstChart = order.indexOf('chart');
    const firstPanel = order.indexOf('panel');
    expect(firstChart, 'the chart comes after the side panel in the tab order').toBeLessThan(firstPanel);
  });

  test('arrow keys move a selection through the chart, and Escape clears it', async ({ page }) => {
    await ready(page);
    await page.locator('.chart-area svg').first().focus();
    await page.waitForTimeout(200);
    expect(await selectionCount(page), 'something was already selected before any key').toBe(0);

    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(350);
    const first = await selectionCount(page);
    expect(first, 'ArrowDown selected nothing').toBe(1);

    const firstId = await page.evaluate(() =>
      document.querySelector('[data-pp-selected="1"]')?.getAttribute('data-pp-id') ?? null);
    expect(firstId, 'nothing in the DOM reports itself as selected').toBeTruthy();

    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(350);
    const secondId = await page.evaluate(() =>
      document.querySelector('[data-pp-selected="1"]')?.getAttribute('data-pp-id') ?? null);
    expect(secondId, 'a second ArrowDown did not move the selection on').not.toBe(firstId);

    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(350);
    const backId = await page.evaluate(() =>
      document.querySelector('[data-pp-selected="1"]')?.getAttribute('data-pp-id') ?? null);
    expect(backId, 'ArrowUp did not come back').toBe(firstId);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(await selectionCount(page), 'Escape did not clear the selection').toBe(0);
  });

  test('what the keyboard selects can then be renamed and deleted by keyboard', async ({ page }) => {
    await ready(page);
    const before = await page.locator('.task-bar-body').count();
    await page.locator('.chart-area svg').first().focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(350);

    // F2 is what the shortcuts sheet promises.
    await page.keyboard.press('F2');
    await page.waitForTimeout(400);
    const editing = await page.evaluate(() =>
      !!document.querySelector('.inline-label input, .inline-label textarea, foreignObject input'));
    expect(editing, 'F2 on a keyboard-made selection opened no editor').toBe(true);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    await page.keyboard.press('Delete');
    await page.waitForTimeout(450);
    const after = await page.locator('.task-bar-body').count();
    expect(after, `Delete on a keyboard-made selection removed nothing (${before} bars before, ${after} after)`).toBeLessThan(before);
  });

  test('the chart says out loud what was selected', async ({ page }) => {
    await ready(page);
    await page.locator('.chart-area svg').first().focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(450);
    const live = await page.evaluate(() =>
      [...document.querySelectorAll('[role="status"], [aria-live]')]
        .map((e) => (e.textContent ?? '').trim())
        .filter(Boolean));
    expect(live.join(' | '), 'no live region mentions what is now selected').toMatch(/\w{3,}/);
  });
});
