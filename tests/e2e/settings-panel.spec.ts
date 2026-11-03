import { test, expect, type Page } from '@playwright/test';

/**
 * The settings panel, driven in the real app (SRS-SET-001…014).
 *
 * The unit layer can say that the panel binds the same store field as the
 * command bar; it cannot say whether the index follows the scroll, whether the
 * last section is ever reachable, or whether a drag that ends on the backdrop
 * closes the panel out from under the planner. Those are the three things that
 * were wrong often enough in PowerScroll to be commented in its source, so they
 * are what this drives.
 *
 * Owner directive 2026-11-02: "lets reintegrate the settings menu from
 * powerscroll. It's not matching."
 */

const ready = async (page: Page) => {
  await page.goto('/');
  await page.locator('.chart-area svg').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('.task-bar-body').length > 0);
  await page.waitForTimeout(300);
};

const openSettings = async (page: Page) => {
  await page.getByRole('button', { name: 'Settings, about and updates' }).click();
  await page.getByTestId('settings-panel').waitFor({ state: 'visible' });
};

/** How far a section's top sits from the top of the scrolling pane. */
const offsetOf = (page: Page, id: string) =>
  page.evaluate((section) => {
    const pane = document.querySelector<HTMLElement>('[data-testid="settings-scroll"]')!;
    const el = pane.querySelector<HTMLElement>(`[data-section="${section}"]`)!;
    return el.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  }, id);

test.describe('settings panel', () => {
  test('holds a section for every entry in its index', async ({ page }) => {
    await ready(page);
    await openSettings(page);

    const ids = ['look', 'calendar', 'saving', 'bridge', 'about'];
    for (const id of ids) {
      await expect(page.getByTestId(`settings-index-${id}`)).toBeVisible();
      await expect(page.locator(`[data-section="${id}"]`)).toHaveCount(1);
    }
    // The one-section dialog this replaced had no index at all, so the count
    // is the thing that moved (SRS-SET-001).
    await expect(page.getByTestId('settings-index').getByRole('button')).toHaveCount(ids.length);
  });

  test('scrolls a section to the top when its index entry is used', async ({ page }) => {
    await ready(page);
    await openSettings(page);

    // `saving` is the middle section, so there is content below it to scroll up
    // into and "to the top" is a claim that can be met exactly.
    const before = await offsetOf(page, 'saving');
    expect(before, 'the saving section should start below the fold').toBeGreaterThan(200);

    await page.getByTestId('settings-index-saving').click();
    await page.waitForTimeout(600); // smooth scroll
    expect(await offsetOf(page, 'saving')).toBeLessThan(60);
    await expect(page.getByTestId('settings-index-saving')).toHaveAttribute('aria-current', 'true');
  });

  test('goes as far as the pane allows for a section near the end', async ({ page }) => {
    await ready(page);
    await openSettings(page);

    /**
     * Measured on a desktop: the bridge section stops 77px from the top,
     * because there is not enough content below it to scroll further. On a
     * phone the rows stack, every section is taller, and the same section
     * reaches the top with room to spare. Both satisfy SRS-SET-002 — "to the
     * top, or as far as the pane goes" — so the gate asserts the disjunction
     * and names which arm held, rather than widening a tolerance until one
     * number fits two layouts.
     */
    await page.getByTestId('settings-index-bridge').click();
    await page.waitForTimeout(600);

    const atEnd = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>('[data-testid="settings-scroll"]')!;
      return pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2;
    });
    const offset = await offsetOf(page, 'bridge');
    expect(
      offset < 60 || atEnd,
      `the bridge section sat ${Math.round(offset)}px down with the pane ${atEnd ? 'at' : 'not at'} its end`,
    ).toBe(true);
    // Either way, the control the section exists for has to be on screen.
    await expect(page.getByTestId('settings-bridge-toggle')).toBeInViewport();
  });

  test('marks the last section, which is too short to reach the top on its own', async ({ page }) => {
    await ready(page);
    await openSettings(page);

    // The failure this guards: a final section shorter than the pane can never
    // scroll its heading past the top, so the index would skip it for ever —
    // the one entry a planner cannot confirm they are looking at (SRS-SET-003).
    await page.getByTestId('settings-scroll').evaluate((pane) => {
      pane.scrollTop = pane.scrollHeight;
    });
    await page.waitForTimeout(250);
    await expect(page.getByTestId('settings-index-about')).toHaveAttribute('aria-current', 'true');
  });

  test('closes on Escape and on a press that starts on the backdrop', async ({ page }) => {
    await ready(page);
    await openSettings(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-panel')).toHaveCount(0);

    await openSettings(page);
    await page.getByTestId('settings-scrim').click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId('settings-panel')).toHaveCount(0);
  });

  test('stays open when a drag starts inside it and ends outside', async ({ page }) => {
    await ready(page);
    await openSettings(page);

    // Closing on `click` rather than `mousedown` reads as the panel vanishing
    // mid-interaction: the release lands on the backdrop and the press did not.
    const box = (await page.getByTestId('settings-panel').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(5, 5, { steps: 8 });
    await page.mouse.up();

    await expect(page.getByTestId('settings-panel')).toBeVisible();
  });

  test('shows the same answer as the command bar, in both directions', async ({ page }) => {
    await ready(page);

    // Panel → chart. Theme is the one setting whose effect is visible from
    // outside either control, so a stale copy cannot hide behind agreement.
    await openSettings(page);
    await page.getByTestId('settings-theme-dark').check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByTestId('settings-delimiter-month')).not.toBeChecked();

    await page.getByTestId('settings-delimiter-month').check();
    await page.keyboard.press('Escape');

    // Chart → panel: reopening reads the store, not a remembered snapshot.
    await openSettings(page);
    await expect(page.getByTestId('settings-delimiter-month')).toBeChecked();
    await expect(page.getByTestId('settings-theme-dark')).toBeChecked();
  });

  test('says which file the plan is bound to, and what it would be written as', async ({ page }) => {
    await ready(page);
    await openSettings(page);
    await page.getByTestId('settings-index-saving').click();
    await page.waitForTimeout(400);

    // Nothing is bound in a fresh tab, and saying so is the point: "which file"
    // with no answer is exactly the half a planner cannot work out for
    // themselves (SRS-SET-012).
    await expect(page.getByTestId('settings-file-name')).toHaveText('Not linked to a file');
    await expect(page.getByTestId('settings-save-state')).toContainText('Kept in this browser only');
  });

  test('remembers the bridge answer across a reload, and starts off', async ({ page }) => {
    await ready(page);
    await openSettings(page);
    await page.getByTestId('settings-index-bridge').click();
    await page.waitForTimeout(400);

    await expect(page.getByTestId('settings-bridge-toggle')).not.toBeChecked();
    await expect(page.getByTestId('settings-bridge-status')).toHaveAttribute('data-status', 'off');
    await expect(page.getByTestId('settings-bridge-url')).toHaveCount(0);

    await page.getByTestId('settings-bridge-toggle').check();
    // The address only appears once there is a connection to point somewhere.
    await expect(page.getByTestId('settings-bridge-url')).toBeVisible();

    await page.reload();
    await ready(page);
    await openSettings(page);
    await page.getByTestId('settings-index-bridge').click();
    await page.waitForTimeout(400);
    await expect(page.getByTestId('settings-bridge-toggle')).toBeChecked();

    // Put it back, so the next test in this file starts from off.
    await page.getByTestId('settings-bridge-toggle').uncheck();
    await expect(page.getByTestId('settings-bridge-status')).toHaveAttribute('data-status', 'off');
  });

  test('says why nothing answered, rather than waiting for ever', async ({ page }) => {
    /**
     * SRS-ABR-063: the status used to sit on "Waiting" indefinitely, because
     * every reconnect rewrote the reason away within a second.
     *
     * The address is set before the page loads and points at a port nothing can
     * be listening on. The first version of this test simply ticked the box and
     * assumed no bridge was running — and went green-then-red depending on
     * whether a real MCP server happened to be up on this machine, which is a
     * test measuring the room it is in rather than the code.
     */
    await page.addInitScript(() => {
      try {
        localStorage.setItem('powerplanner-bridge-enabled', 'true');
        localStorage.setItem('powerplanner-bridge-url', 'ws://127.0.0.1:9/agent');
      } catch {
        /* a browser refusing storage fails the assertions below, which is right */
      }
    });
    await ready(page);
    await openSettings(page);
    await page.getByTestId('settings-index-bridge').click();
    await page.waitForTimeout(300);

    await expect(page.getByTestId('settings-bridge-status')).toHaveAttribute('data-status', 'error', {
      timeout: 15000,
    });
    await expect(page.getByTestId('settings-bridge-error')).toContainText('No agent bridge answered');
    await expect(page.getByTestId('settings-bridge-error')).toContainText('127.0.0.1:9');
    // And it holds, instead of being overwritten by the next attempt.
    await page.waitForTimeout(2500);
    await expect(page.getByTestId('settings-bridge-status')).toHaveAttribute('data-status', 'error');
    await expect(page.getByTestId('settings-index-bridge-meta')).toHaveText('Cannot');

    await page.getByTestId('settings-bridge-toggle').uncheck();
    await expect(page.getByTestId('settings-bridge-status')).toHaveAttribute('data-status', 'off');
  });

  test('keeps Tab inside the panel and does not strand focus on close', async ({ page }) => {
    await ready(page);
    await openSettings(page);

    for (let i = 0; i < 25; i++) await page.keyboard.press('Tab');
    const inside = await page.evaluate(
      () => !!document.activeElement?.closest('[data-testid="settings-panel"]'),
    );
    expect(inside, 'focus escaped the panel').toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-panel')).toHaveCount(0);

    /**
     * Focus goes back where it came from, and on a touch browser that is
     * nowhere: tapping a button does not focus it in mobile WebKit, so the
     * opener was never focused and `useDialogFocus` has nothing to restore.
     * Asserting the gear outright failed on tablet and mobile for that reason,
     * which is the browser behaving correctly. What must hold on every device
     * is that focus is not left on a node that has been removed — the state
     * SRS-LAY-058 exists to prevent.
     */
    const landed = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return {
        detached: !!active && !document.body.contains(active),
        onOpener: active?.getAttribute('title') === 'Settings, about and updates',
        onBody: active === document.body || active === null,
      };
    });
    expect(landed.detached, 'focus was left on a removed node').toBe(false);
    expect(landed.onOpener || landed.onBody).toBe(true);
  });

  test('is usable at phone width', async ({ page }) => {
    await ready(page);
    await openSettings(page);

    // The index becomes a strip above the sections; a 216px rail beside a 170px
    // label column does not fit 375px, and the bridge toggle lives in there
    // (SRS-SET-005).
    const layout = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('.settings-panel__body')!;
      const index = document.querySelector<HTMLElement>('[data-testid="settings-index"]')!;
      const scroll = document.querySelector<HTMLElement>('[data-testid="settings-scroll"]')!;
      return {
        stacked: index.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().top + 1,
        wide: body.scrollWidth > body.clientWidth + 1,
        panelWidth: document.querySelector<HTMLElement>('.settings-panel')!.getBoundingClientRect().width,
        viewport: window.innerWidth,
      };
    });

    if (layout.viewport <= 768) {
      expect(layout.stacked, 'the index should sit above the sections on a phone').toBe(true);
      expect(layout.panelWidth).toBeLessThanOrEqual(layout.viewport);
    } else {
      expect(layout.stacked, 'the index should sit beside the sections on a desktop').toBe(false);
    }
    expect(layout.wide, 'the panel should not scroll sideways').toBe(false);
  });
});
