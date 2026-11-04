import { test, expect, type Page } from '@playwright/test';

/**
 * The v2.37.0 asks, driven rather than read.
 *
 * SRS-ELEM-075 a bar with no fill; SRS-ELEM-076 a bigger, more vibrant
 * palette; SRS-ELEM-077 the marker band at the foot of the chart and a readout
 * while dragging; SRS-LAY-061 the configurable row rule; SRS-EDIT-090 the row
 * menu; SRS-EDIT-091 reordering by dragging.
 *
 * Desktop only: every one of these is a pointer gesture against the gutter or
 * the panel, and the panel is a sheet at phone width.
 */
test.describe('outline-only bars, rows and markers', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'pointer-driven; desktop only');
    await page.goto('/');
    await page.locator('.chart-area svg').first().waitFor({ state: 'visible' });
  });

  /** The bar's own group, which is where the outline and the fills live. */
  const barParts = (page: Page, id: string) =>
    page.evaluate((barId) => {
      const body = document.querySelector(`.task-bar-body[data-pp-id="${barId}"]`);
      const g = body?.parentElement;
      if (!g) return null;
      const outline = g.querySelector('.bar-outline');
      const progress = g.querySelector('.bar-progress-fill');
      return {
        outline: outline?.getAttribute('data-pp-outline') ?? null,
        stroke: outline?.getAttribute('stroke') ?? null,
        dash: outline?.getAttribute('stroke-dasharray') ?? null,
        // The painted body itself. Asked of every rect in the group instead,
        // this would also catch the grips and the progress handle, which are
        // drawn whenever the bar is selected and are not the bar's fill.
        track: g.querySelector('[data-pp-track]')?.getAttribute('fill') ?? null,
        progressFill: progress?.getAttribute('fill') ?? null,
      };
    }, id);

  test('a bar can be drawn with no fill, framed by a dashed outline (SRS-ELEM-075)', async ({ page }) => {
    const bar = page.locator('.task-bar-body').first();
    const id = await bar.getAttribute('data-pp-id');
    expect(id).toBeTruthy();

    // The control. A bar starts filled, so "nothing is filled" below cannot
    // pass against a chart that never drew anything.
    const before = await barParts(page, id!);
    expect(before, 'the bar group was not found').not.toBeNull();
    expect(before!.track, 'a bar starts with a painted body').toBeTruthy();
    expect(before!.track).not.toBe('none');
    expect(before!.outline).toBeNull();

    await bar.click();
    const swatch = page.locator('[data-pp-swatch="none"]').first();
    await expect(swatch).toBeVisible();
    await swatch.click();

    const after = await barParts(page, id!);
    expect(after!.track, 'the painted body is still there').toBeNull();
    expect(after!.outline, 'no fill left the bar with no frame either').toBe('dashed');
    expect(after!.dash).toBeTruthy();
    // Not a literal black: that is an invisible bar on the dark sheet.
    expect(after!.stroke).toBe('var(--bar-ink)');
  });

  test('the palette offers more colours, including black (SRS-ELEM-076)', async ({ page }) => {
    await page.locator('.task-bar-body').first().click();
    const swatches = page.locator('[data-pp-swatch]');
    await expect(swatches.first()).toBeVisible();
    // 16 presets + black + the no-fill swatch.
    expect(await swatches.count()).toBeGreaterThanOrEqual(17);
    await expect(page.getByRole('button', { name: 'Black', exact: true })).toBeVisible();
  });

  test('a milestone can be given its own colour (SRS-ELEM-076)', async ({ page }) => {
    await page.locator('[data-pp-kind="milestone"]').first().click();
    await expect(page.getByRole('button', { name: 'Crimson milestone' })).toBeVisible();
  });

  test('the row menu leads with adding a row, and adds one below (SRS-EDIT-090)', async ({ page }) => {
    const rows = page.locator('[data-pp-kind="row"]');
    const before = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.ppId));

    const target = rows.nth(1);
    const box = await target.boundingBox();
    await page.mouse.click(box!.x + 20, box!.y + box!.height / 2, { button: 'right' });
    const menu = page.locator('[role="menu"]').first();
    await expect(menu.getByRole('menuitem', { name: 'Add row above' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Add row below' }).click();

    const after = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.ppId));
    expect(after).toHaveLength(before.length + 1);
    // Below the row that was clicked, not at the end of the plan.
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(after[2]).not.toBe(before[2]);
  });

  test('a row is reordered by dragging it in the row list (SRS-EDIT-091)', async ({ page }) => {
    const rows = page.locator('[data-pp-kind="row"]');
    const before = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.ppId));

    /*
     * A row from the middle of the visible list, up to the top.
     *
     * Not the first row down: that is a section dropped among its own
     * children, which `dropIndex` correctly refuses, so a test asserting
     * "something changed" would fail for being right. And not the LAST row,
     * which on this fixture is scrolled below the window — its box is off
     * screen and the press lands nowhere.
     */
    const SOURCE = 4;
    const from = await rows.nth(SOURCE).boundingBox();
    const first = await rows.nth(0).boundingBox();
    await page.mouse.move(from!.x + 30, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(first!.x + 30, first!.y + 2, { steps: 12 });
    // Where it will land, said while the pointer is still down.
    await expect(page.locator('[data-pp-rowdrop]')).toBeVisible();
    await page.mouse.up();

    const after = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.ppId));
    expect(after).toHaveLength(before.length);
    expect(after, 'the drag changed nothing').not.toEqual(before);
    expect(after[0], 'the dragged row did not land at the top').toBe(before[SOURCE]);
    // Reordered, not duplicated and not dropped.
    expect(new Set(after)).toEqual(new Set(before));
  });

  test('the row separator answers its setting (SRS-LAY-061)', async ({ page }) => {
    // What the chart drew before the setting existed. Counted rather than
    // asked `toBeVisible`: a zero-height <line> has no box, so Playwright
    // calls every rule on the sheet hidden.
    await expect(page.locator('[data-pp-rowsep="solid"]')).not.toHaveCount(0);
    const groupsOnly = await page.locator('[data-pp-rowsep]').count();

    await page.getByRole('button', { name: 'Settings, about and updates' }).click();
    // By test id: the control is a `radiogroup`, which `getByRole('group')`
    // does not match, and the labels ("None") repeat across the section.
    await page.getByTestId('settings-rowsep-dashed').click();
    await expect(page.locator('[data-pp-rowsep="dashed"]')).not.toHaveCount(0);
    await expect(page.locator('[data-pp-rowsep="solid"]')).toHaveCount(0);

    // The width and the scope only exist while there is a line to apply them to.
    await page.getByTestId('settings-rowsep-width-3').click();
    await expect(page.locator('[data-pp-rowsep]').first()).toHaveAttribute('stroke-width', '3');

    await page.getByTestId('settings-rowsep-scope-all').click();
    expect(await page.locator('[data-pp-rowsep]').count()).toBeGreaterThan(groupsOnly);

    await page.getByTestId('settings-rowsep-none').click();
    await expect(page.locator('[data-pp-rowsep]')).toHaveCount(0);
  });

  test('the marker band sits at the foot of the chart (SRS-ELEM-077)', async ({ page }) => {
    const band = page.locator('[data-pp-markerband]').first();
    await expect(band).toBeVisible();
    const bandBox = await band.boundingBox();
    const chartBox = await page.locator('.chart-area svg').first().boundingBox();
    // Nothing below it. It used to float 52px up, reserving room for a command
    // bar that is a grid column and never overlapped the chart at all.
    const gap = chartBox!.y + chartBox!.height - (bandBox!.y + bandBox!.height);
    expect(gap, `the band floats ${Math.round(gap)}px above the bottom`).toBeLessThanOrEqual(2);
  });

  test('a dragged marker says the date and the step it moves in (SRS-ELEM-077)', async ({ page }) => {
    const marker = page.locator('[data-pp-kind="marker"]').first();
    const box = await marker.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 40);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 60, box!.y + 40, { steps: 10 });

    const readout = page.locator('[data-pp-marker-readout]').first();
    await expect(readout).toBeVisible();
    // The magnet rounds to seven days on every scale but `day`, which the
    // owner had to guess at. It says so now.
    await expect(readout).toContainText('in steps of a week');
    // And it is near the top of the plot, where it can be read whatever the
    // plan is scrolled to — not parked at the foot beside the chip.
    const rBox = await readout.boundingBox();
    const chartBox = await page.locator('.chart-area svg').first().boundingBox();
    expect(rBox!.y - chartBox!.y).toBeLessThan(chartBox!.height / 2);
    await page.mouse.up();
  });
});

/**
 * The same reorder, by finger (SRS-EDIT-091).
 *
 * Separate from the block above because that one is desktop-only and this one
 * needs the opposite: a project with a touchscreen. The gesture is built on
 * pointer events precisely so one implementation answers both, and "it should
 * work, they're pointer events" is not a measurement.
 */
test.describe('reordering rows by finger', () => {
  test('a touch drag moves a row (SRS-EDIT-091)', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, 'needs a touchscreen');
    await page.goto('/');
    await page.locator('.chart-area svg').first().waitFor({ state: 'visible' });

    const rows = page.locator('[data-pp-kind="row"]');
    const before = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.ppId));
    const from = await rows.nth(4).boundingBox();
    const first = await rows.nth(0).boundingBox();

    // A real touch sequence, not a mouse one: `touch-action: none` on the row
    // is what stops the browser claiming this as a pan before we see it.
    await page.touchscreen.tap(from!.x + 20, from!.y + from!.height / 2);
    await page.locator('[data-pp-kind="row"]').nth(4).dispatchEvent('pointerdown', {
      pointerType: 'touch', isPrimary: true, button: 0,
      clientX: from!.x + 20, clientY: from!.y + from!.height / 2,
    });
    for (let i = 1; i <= 8; i++) {
      const y = from!.y + from!.height / 2 + ((first!.y + 2) - (from!.y + from!.height / 2)) * (i / 8);
      await page.evaluate(
        ([x, yy]) => window.dispatchEvent(
          new PointerEvent('pointermove', { pointerType: 'touch', clientX: x as number, clientY: yy as number, bubbles: true }),
        ),
        [from!.x + 20, y],
      );
    }
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true })));

    const after = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.ppId));
    expect(after, 'the touch drag changed nothing').not.toEqual(before);
    expect(after[0]).toBe(before[4]);
    expect(new Set(after)).toEqual(new Set(before));
  });
});
