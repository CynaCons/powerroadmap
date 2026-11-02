import { test, expect, type Page } from '@playwright/test';

/**
 * SRS-EXP-005 — printing puts the whole plan on paper.
 *
 * The chart is not a scrollable element: the SVG is exactly the size of the
 * window and the plan moves under it through `scrollY`. So `window.print()`
 * printed the window. A 39-row plan in an 800px window came out as one page
 * holding the eleven rows that happened to be on screen, with no indication
 * that anything was missing — and the rows below the fold were not cut off at
 * the page edge, they were never painted.
 *
 * Both halves are measured here against the real print path: `beforeprint` is
 * the event the browser fires before it snapshots the page, and
 * `emulateMedia({ media: 'print' })` is the stylesheet it then applies.
 *
 * The first test carries its own negative control — it asserts the plan really
 * is taller than the window first, so it cannot pass by printing a plan that
 * already fitted.
 */

const ready = async (page: Page) => {
  await page.goto('/');
  await page.locator('.chart-area svg').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('.task-bar-body').length > 0);
  await page.waitForTimeout(500);
};

/** Every row's box, and the box of the sheet they are painted on. */
const rowGeometry = (page: Page) =>
  page.evaluate(() => {
    const svg = document.querySelector('.chart-area svg') as SVGSVGElement;
    const sheet = svg.getBoundingClientRect();
    const rows = [...document.querySelectorAll('[data-pp-kind="row"]')].map((el) => {
      const r = (el as SVGGraphicsElement).getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, h: r.height };
    });
    return {
      sheet: { top: sheet.top, bottom: sheet.bottom, h: sheet.height },
      rows,
      // A row is on the sheet when its whole box is inside it. Half a row at
      // the fold is a row the reader cannot read.
      onSheet: rows.filter((r) => r.top >= sheet.top - 1 && r.bottom <= sheet.bottom + 1).length,
    };
  });

const enterPrint = async (page: Page) => {
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.waitForTimeout(250);
};

test.describe('printing puts every row on paper (SRS-EXP-005)', () => {
  test('the rows below the fold are printed, not dropped', async ({ page }) => {
    await ready(page);

    const before = await rowGeometry(page);
    expect(before.rows.length, 'the plan has no rows to print').toBeGreaterThan(5);
    // The negative control. Without this the test would pass on any plan that
    // happens to fit the window, which is the one case the defect never hit.
    expect(
      before.onSheet,
      `this plan fits the window (${before.rows.length} rows on a ${Math.round(before.sheet.h)}px sheet), so printing it proves nothing`,
    ).toBeLessThan(before.rows.length);

    await enterPrint(page);

    const after = await rowGeometry(page);
    expect(after.rows.length, 'printing lost rows from the document').toBe(before.rows.length);
    expect(
      after.onSheet,
      `${after.rows.length - after.onSheet} of ${after.rows.length} rows are still outside the printed sheet`,
    ).toBe(after.rows.length);
  });

  test('the sheet grows to the plan instead of the window', async ({ page }) => {
    await ready(page);
    const windowH = await page.evaluate(() => window.innerHeight);
    const before = await rowGeometry(page);

    await enterPrint(page);
    const after = await rowGeometry(page);

    expect(after.sheet.h, 'the printed sheet is still the height of the window').toBeGreaterThan(before.sheet.h);
    // The rows alone are taller than the window on this plan, so the sheet has
    // to clear it.
    expect(after.sheet.h).toBeGreaterThan(windowH);
  });

  test('printing starts at the top of the plan however far it was scrolled', async ({ page }) => {
    await ready(page);
    // Dispatched rather than driven through `page.mouse.wheel`, which mobile
    // WebKit does not implement — and two of the three projects are WebKit.
    // The chart registers its own non-passive `wheel` listener, so this is the
    // shipped handler either way; the assertion below checks it actually moved.
    // On the SVG itself: that is where the listener is registered, and the
    // event would not reach it from the container above.
    await page.evaluate(() => {
      document
        .querySelector('.chart-area svg')!
        .dispatchEvent(new WheelEvent('wheel', { deltaY: 1200, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(300);
    const scrolled = await page.evaluate(() => {
      const el = document.querySelector('[data-pp-kind="row"]') as SVGGraphicsElement;
      return el.getBoundingClientRect().top;
    });
    const sheetTop = await page.evaluate(
      () => (document.querySelector('.chart-area svg') as SVGSVGElement).getBoundingClientRect().top,
    );
    expect(scrolled, 'the wheel did not scroll the plan, so this test is not measuring anything').toBeLessThan(sheetTop);

    await enterPrint(page);
    const after = await rowGeometry(page);
    expect(after.onSheet, 'a scrolled plan printed from where it was scrolled to').toBe(after.rows.length);
  });

  test('the page can break, so a long plan is more than one page', async ({ page }) => {
    await ready(page);
    await enterPrint(page);

    const paper = await page.evaluate(() => {
      const shell = document.querySelector('.app-shell') as HTMLElement;
      const area = document.querySelector('.chart-area') as HTMLElement;
      return {
        // The HEIGHT is the half that matters: a shell pinned to 100vh gives
        // the browser one page and nothing to paginate, whatever does not fit
        // being gone. `overflow` on .app-shell is never declared outside the
        // print block, so reading it had no failing state at all - a check
        // that cannot go red is worse than no check.
        shellHeight: Math.round(shell.getBoundingClientRect().height),
        areaOverflow: getComputedStyle(area).overflow,
        docScroll: document.documentElement.scrollHeight,
        viewport: window.innerHeight,
      };
    });

    expect(paper.areaOverflow, 'the chart still clips what will not fit on the page').toBe('visible');
    expect(
      paper.shellHeight,
      'the shell is still the height of the window, so there is only ever one page',
    ).toBeGreaterThan(paper.viewport);
    expect(
      paper.docScroll,
      'the printable document is still one viewport tall, so there is nothing for the printer to paginate',
    ).toBeGreaterThan(paper.viewport);
  });

  test('the window goes back to normal after printing', async ({ page }) => {
    await ready(page);
    const before = await rowGeometry(page);
    await enterPrint(page);
    // Without this the test passes when printing never grew anything: two
    // identical window-height sheets also satisfy the restore assertion.
    const printed = await rowGeometry(page);
    expect(
      printed.sheet.h,
      'the sheet never grew, so this test is not measuring a restore',
    ).toBeGreaterThan(before.sheet.h);
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.waitForTimeout(250);

    const after = await rowGeometry(page);
    expect(Math.round(after.sheet.h), 'the chart stayed at print height after the dialog closed').toBe(
      Math.round(before.sheet.h),
    );
  });
});
