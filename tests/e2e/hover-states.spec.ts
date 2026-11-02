import { test, expect, type Page } from '@playwright/test';

/**
 * SRS-THEME-009 — hovering something changes it.
 *
 * The header's own background IS `--color-bg-panel`, and the header button's
 * hover painted `--color-bg-panel`. White on white: forcing `:hover` and
 * diffing the pixels, 25 of 48 controls repainted nothing at all. In the
 * chart only task bars answered the pointer — a milestone, a marker and a row
 * each repainted zero pixels, so nothing said they could be clicked.
 *
 * Measured as pixels, not as computed style: a rule that resolves to the
 * colour already underneath is exactly the bug, and only a screenshot can
 * tell the difference.
 */

const ready = async (page: Page) => {
  await page.goto('/');
  await page.locator('.chart-area svg').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('.task-bar-body').length > 0);
  await page.waitForTimeout(700);
};

/** How many bytes of the element's own patch change when the pointer rests on it. */
async function hoverDelta(page: Page, selector: string): Promise<number | null> {
  const el = page.locator(selector).first();
  if (!(await el.count())) return null;
  const box = await el.boundingBox();
  if (!box) return null;
  const clip = {
    x: Math.max(0, box.x - 6),
    y: Math.max(0, box.y - 6),
    width: Math.min(320, box.width + 12),
    height: Math.min(90, box.height + 12),
  };
  // Park the pointer somewhere that is certainly not the subject.
  await page.mouse.move(2, 2);
  await page.waitForTimeout(260);
  const before = await page.screenshot({ clip });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(320);
  const after = await page.screenshot({ clip });
  let changed = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    if (before[i] !== after[i]) changed++;
  }
  return changed;
}

test.describe('hovering says a thing can be clicked (SRS-THEME-009)', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 900, 'needs the desktop chrome and chart');

  const SUBJECTS: [string, string][] = [
    ['a header button on the bare header', 'button[title*="Settings" i]'],
    ['a header button inside a cluster', 'button[title*="snap" i]'],
    ['a task bar', '.task-bar-body'],
    ['a milestone', '[data-pp-kind="milestone"]'],
    ['a row in the gutter', 'g[data-pp-kind="row"]'],
  ];

  for (const [what, selector] of SUBJECTS) {
    test(`${what} repaints on hover`, async ({ page }) => {
      await ready(page);
      const delta = await hoverDelta(page, selector);
      expect(delta, `${selector} was not on screen to hover`).not.toBeNull();
      expect(delta!, `hovering ${what} changed ${delta} bytes — it paints the colour already there`).toBeGreaterThan(40);
    });
  }

  test('and something inert does NOT repaint, so the instrument means something', async ({ page }) => {
    await ready(page);
    // The status bar's own text is not interactive and has no hover rule. If
    // this also "changed", the measurement would be noise rather than hover.
    const delta = await hoverDelta(page, '.app-status');
    expect(delta, 'the status bar was not on screen').not.toBeNull();
    expect(delta!, 'an element with no hover state repainted anyway — the diff is measuring noise').toBeLessThan(40);
  });
});
