import { test, expect, type Page } from '@playwright/test';

/**
 * SRS-PERS-041 — a file the app cannot lay out is refused, and the planner is
 * told which field is wrong.
 *
 * The validator is unit-tested in `tests/unit/dateValidation.test.ts`. What
 * that cannot show is whether its message ever reaches a human: `openIntoApp`
 * puts it in a notice, and a message that names a row index and nothing else
 * is no use in a 200-row plan. So this drives the real menu item, through the
 * real open path, and reads what appears on screen.
 *
 * The picker is the one thing stubbed, because a browser file dialog cannot be
 * driven from a test. Everything after it — `openFile`, `parseFileContents`,
 * `validateDocument`, `notify` — is the shipped path.
 *
 * Observed on v2.35.0: the file opened, the notice said "Opened
 * wedged.json", and the chart went blank — no axis, no bars, no message.
 */

const BAD = JSON.stringify({
  schemaVersion: 1,
  title: 'Wedged',
  calendar: { scale: 'week', fiscalYearStart: 1, workingDays: [1, 2, 3, 4, 5], holidays: [] },
  rows: [{ id: 'r1', label: 'Alpha', groupId: null }],
  tasks: [{ id: 't1', rowId: 'r1', label: 'Impossible', start: '2026-13-45', end: '2026-03-10' }],
  milestones: [],
  brackets: [],
  dependencies: [],
  markers: [],
  style: { theme: 'light', preset: 'default' },
});

const GOOD = BAD.replace('2026-13-45', '2026-03-01');

const ready = async (page: Page) => {
  await page.goto('/');
  await page.locator('.chart-area svg').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('.task-bar-body').length > 0);
  await page.waitForTimeout(400);
};

/** Make the next Open return this file, without a dialog. */
const stubPicker = (page: Page, name: string, text: string) =>
  page.evaluate(
    ([n, t]) => {
      (window as unknown as Record<string, unknown>).showOpenFilePicker = async () => [
        {
          name: n,
          kind: 'file',
          getFile: async () => new File([t as string], n as string, { type: 'application/json' }),
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
          isSameEntry: async () => false,
        },
      ];
    },
    [name, text],
  );

const openFromMenu = async (page: Page) => {
  await page.getByRole('button', { name: /file/i }).first().click();
  await page.getByText('Open file…').click();
  await page.waitForTimeout(600);
};

/**
 * The TOAST, not the status bar.
 *
 * `.notice-status` is capped at 44ch with `text-overflow: ellipsis`, and this
 * message is 91 characters - so reading it with `innerText`, which ignores
 * clipping, asserted on text the planner can never see. The toast wraps and
 * carries the whole thing, and the live region announces it in full.
 */
const noticeText = async (page: Page) => {
  const toast = page.locator('.notice--fail').first();
  await expect(toast, 'no refusal notice appeared at all').toBeVisible();
  return toast.innerText();
};

/** What the status bar can actually SHOW, not what its DOM holds. */
const barShowsItAll = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('.notice-status') as HTMLElement | null;
    if (!el) return null;
    return el.scrollWidth <= el.clientWidth + 1;
  });

test.describe('a file with an impossible date is refused, out loud (SRS-PERS-041)', () => {
  test('the notice names the field and quotes the date', async ({ page }) => {
    await ready(page);
    await stubPicker(page, 'wedged.json', BAD);
    await openFromMenu(page);

    const said = await noticeText(page);
    expect(said, 'nothing on screen mentioned the file at all').toContain('wedged.json');
    expect(said, 'the notice does not say which field holds the bad date').toContain('tasks[0]');
    expect(said, 'the notice does not quote the date that is wrong').toContain('2026-13-45');

    // The status bar truncates this message, which is by design - it is a
    // 44ch echo of the one announced copy. Asserted so that the toast stays
    // the surface this test depends on, rather than the bar quietly becoming
    // the only place the text appears and then clipping it.
    expect(await barShowsItAll(page), 'the status bar unexpectedly fits 91 characters').toBe(false);
  });

  test('the chart the planner had is still there', async ({ page }) => {
    await ready(page);
    const before = await page.evaluate(() => ({
      title: document.title,
      bars: document.querySelectorAll('.task-bar-body').length,
    }));
    expect(before.bars).toBeGreaterThan(0);

    await stubPicker(page, 'wedged.json', BAD);
    await openFromMenu(page);

    const after = await page.evaluate(() => ({
      title: document.title,
      bars: document.querySelectorAll('.task-bar-body').length,
      axisTicks: document.querySelectorAll('[data-pp-axis="major"] text, [data-pp-axis="minor"] text').length,
    }));
    // The refusal must not be destructive: a half-loaded document is what
    // produced the blank chart in the first place.
    expect(after.bars, 'the refused file replaced the plan that was open').toBe(before.bars);
    expect(after.title).toBe(before.title);
    expect(after.axisTicks, 'the calendar axis went missing').toBeGreaterThan(0);
  });

  test('the same file with a real date opens — the control', async ({ page }) => {
    // Without this, "refuse everything" would pass both tests above.
    await ready(page);
    await stubPicker(page, 'fine.json', GOOD);
    await openFromMenu(page);

    const said = await page.locator('.notice').first().innerText();
    expect(said).toContain('Opened fine.json');
    await expect(page.locator('.task-bar-body')).toHaveCount(1);
  });
});
