import { test, expect, type Page } from '@playwright/test';

/**
 * What the app promises about a selection, and what it did instead.
 *
 * Five separate breakages, all found by measurement against v2.34.2:
 *
 *  - F2 is printed in the shortcuts sheet as "Rename the selection", and it
 *    opened no editor for a bar selected by clicking it. The SAME bar selected
 *    with the marquee renamed fine.
 *  - Ctrl-click added a bar to a selection and could never take one out: the
 *    handler is `else if (!isSelected(id)) add(...)`, so a second ctrl-click
 *    on an already-selected bar did nothing.
 *  - The footer and the Selection panel printed different counts for the same
 *    selection — the panel always exactly one more, because selecting a bar
 *    also selects its row and the panel counted the companion.
 *  - The right-click Delete removed exactly one of four selected bars, posted
 *    no notice, and left the footer still reading "4 selected".
 *  - Only task bars carried `data-pp-selected`. With a milestone selected the
 *    footer said "1 selected" and nothing in the DOM said which.
 */

const ready = async (page: Page) => {
  await page.goto('/');
  await page.locator('.chart-area svg').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('.task-bar-body').length > 0);
  await page.waitForTimeout(800);
};

const footerCount = async (page: Page) => {
  const t = await page.locator('.app-status').innerText();
  const m = t.match(/(\d+)\s+selected/);
  return m ? Number(m[1]) : null;
};
const panelCount = async (page: Page) => {
  const el = page.locator('[data-pp-section="selection"]');
  if (!(await el.count())) return null;
  const t = await el.innerText();
  const m = t.match(/(\d+)\s+items?\s+selected/);
  return m ? Number(m[1]) : null;
};
const editorOpen = (page: Page) =>
  page.evaluate(() => document.querySelectorAll('foreignObject input, .inline-editor, .inline-label input').length);

test.describe('a selection behaves the same however it was made', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 900, 'needs a desktop chart');

  test('F2 renames a bar picked by clicking, as the shortcuts sheet promises', async ({ page }) => {
    await ready(page);
    await page.locator('.task-bar-body').first().click();
    await page.waitForTimeout(350);
    expect(await footerCount(page), 'the click selected nothing, so F2 has nothing to rename').toBe(1);

    await page.keyboard.press('F2');
    await page.waitForTimeout(450);
    expect(await editorOpen(page), 'F2 on a clicked selection opened no editor').toBeGreaterThan(0);
    await page.keyboard.press('Escape');
  });

  test('and a bar picked with the marquee renames the same way', async ({ page }) => {
    // The control: this path already worked, so if it breaks the test above
    // is no longer isolating the bug it was written for.
    await ready(page);
    const b = await page.locator('.task-bar-body').first().boundingBox();
    await page.keyboard.press('r');
    // Tight to this one bar: a box that reaches into the next row catches two,
    // and F2 then correctly refuses a multi-selection, which would make this
    // control fail for a reason that has nothing to do with what it checks.
    await page.mouse.move(b!.x - 8, b!.y - 4);
    await page.mouse.down();
    await page.mouse.move(b!.x + b!.width + 8, b!.y + b!.height + 4, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(450);
    expect(await footerCount(page), 'the marquee did not select exactly one bar').toBe(1);
    await page.keyboard.press('F2');
    await page.waitForTimeout(450);
    expect(await editorOpen(page), 'F2 after a marquee selection opened no editor either').toBeGreaterThan(0);
    await page.keyboard.press('Escape');
  });

  test('ctrl-click adds a bar and ctrl-click takes it away again', async ({ page }) => {
    await ready(page);
    await page.locator('.task-bar-body').nth(0).click();
    await page.waitForTimeout(250);
    const one = await footerCount(page);
    await page.locator('.task-bar-body').nth(1).click({ modifiers: ['Control'] });
    await page.waitForTimeout(250);
    const two = await footerCount(page);
    expect(two, 'ctrl-click did not add to the selection').toBe((one ?? 0) + 1);

    await page.locator('.task-bar-body').nth(1).click({ modifiers: ['Control'] });
    await page.waitForTimeout(250);
    const back = await footerCount(page);
    expect(back, 'ctrl-clicking a selected bar did not take it out again').toBe(one);
  });

  test('the footer and the panel report the same number', async ({ page }) => {
    await ready(page);
    await page.locator('.task-bar-body').nth(0).click();
    await page.waitForTimeout(250);
    for (const i of [1, 2, 3]) {
      await page.locator('.task-bar-body').nth(i).click({ modifiers: ['Control'] });
      await page.waitForTimeout(280);
      const f = await footerCount(page);
      const p = await panelCount(page);
      if (p === null) continue; // the panel only prints a count for multi-selections
      expect(p, `after ${i + 1} bars the footer says ${f} and the panel says ${p}`).toBe(f);
    }
  });

  test('right-click Delete takes everything that was selected', async ({ page }) => {
    await ready(page);
    const before = await page.locator('.task-bar-body').count();
    await page.locator('.task-bar-body').nth(0).click();
    for (const i of [1, 2]) {
      await page.locator('.task-bar-body').nth(i).click({ modifiers: ['Control'] });
      await page.waitForTimeout(180);
    }
    const selected = await footerCount(page);
    expect(selected, 'could not build a multi-selection').toBe(3);

    const b = await page.locator('.task-bar-body').nth(1).boundingBox();
    await page.mouse.click(b!.x + b!.width / 2, b!.y + b!.height / 2, { button: 'right' });
    await page.waitForTimeout(400);
    const menu = page.locator('[role="menu"], .context-menu').first();
    await menu.getByText(/^Delete/).first().click();
    await page.waitForTimeout(500);

    const after = await page.locator('.task-bar-body').count();
    expect(before - after, `Delete removed ${before - after} of ${selected} selected bars`).toBe(selected);
    expect(await footerCount(page), 'the footer still counts bars that are gone').toBe(0);
  });

  test('every kind of element says in the DOM that it is selected', async ({ page }) => {
    await ready(page);
    const kinds: Record<string, string> = {
      task: '.task-bar-body',
      milestone: '[data-pp-kind="milestone"]',
      marker: '[data-pp-kind="marker"]',
    };
    for (const [kind, sel] of Object.entries(kinds)) {
      const el = page.locator(sel).first();
      if (!(await el.count())) continue;
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      await el.click({ force: true });
      await page.waitForTimeout(350);
      const n = await footerCount(page);
      if (n !== 1) continue; // clicking that kind did not select it; not this test's subject
      const marked = await page.evaluate(() => document.querySelectorAll('[data-pp-selected="1"]').length);
      expect(marked, `a ${kind} is selected but nothing in the DOM says which`).toBeGreaterThan(0);
    }
  });
});
