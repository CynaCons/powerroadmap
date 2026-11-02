import { test, expect, type Page } from '@playwright/test';

/**
 * SRS-THEME-008 and SRS-LAY-055 — two things the app did not say.
 *
 * The whole `prefers-reduced-motion` block was one selector, stopping one
 * indicator dot; section collapse, dialog and palette entry and the chart's
 * own transitions all still played. And the keyboard-shortcuts sheet hid
 * 108px of itself below the fold at 900px tall with nothing at its edge to
 * say there was more.
 */

const ready = async (page: Page) => {
  await page.goto('/');
  await page.locator('.chart-area svg').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(800);
};

/** Properties whose motion is a cross-fade, which reduced motion may keep. */
const FADE_OK = /^(opacity|color|background-color|fill|stroke|border-color|outline-color|box-shadow|filter)$/;

const movingThings = (page: Page) =>
  page.evaluate(() => {
    const out: { sel: string; prop: string; ms: number }[] = [];
    const ms = (s: string) => s.split(',').map((v) => (v.trim().endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000));
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      const props = cs.transitionProperty.split(',').map((s) => s.trim());
      const durs = ms(cs.transitionDuration);
      props.forEach((p, i) => {
        const d = durs[i] ?? durs[0] ?? 0;
        if (p && p !== 'none' && d > 0.01) {
          out.push({ sel: (el.className?.baseVal ?? el.className ?? el.tagName).toString().slice(0, 36), prop: p, ms: d });
        }
      });
      if (cs.animationName && cs.animationName !== 'none') {
        const ad = ms(cs.animationDuration)[0] ?? 0;
        if (ad > 0.01) out.push({ sel: (el.className?.baseVal ?? el.className ?? el.tagName).toString().slice(0, 36), prop: `@${cs.animationName}`, ms: ad });
      }
    }
    return out;
  });

test.describe('reduced motion is honoured (SRS-THEME-008)', () => {
  test('with reduced motion asked for, nothing that MOVES still moves', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await ready(page);
    // Open a section and a dialog so their transitions are in the DOM too.
    await page.locator('[data-pp-section="document"] .cmdbar__section-head').first().click().catch(() => {});
    await page.waitForTimeout(400);

    const moving = await movingThings(page);
    const offenders = moving.filter((m) => !FADE_OK.test(m.prop) && !m.prop.startsWith('@'));
    expect(
      offenders.map((o) => `${o.sel}: ${o.prop} ${o.ms}ms`),
      'these still animate a non-fade property under prefers-reduced-motion: reduce',
    ).toEqual([]);
  });

  test('and without it, things DO move — or the test above proves nothing', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await ready(page);
    const moving = await movingThings(page);
    expect(moving.length, 'nothing in the app transitions at all, so the reduced-motion check is vacuous').toBeGreaterThan(3);
  });
});

test.describe('a scrolling region shows that it scrolls (SRS-LAY-055)', () => {
  test.skip(({ viewport }) => (viewport?.height ?? 0) > 1000, 'needs a window short enough to clip the sheet');

  test('the shortcuts sheet admits it has more below', async ({ page }) => {
    await ready(page);
    await page.keyboard.press('Shift+?');
    await page.waitForTimeout(500);

    const state = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return null;
      let scroller: Element | null = null;
      for (const el of [dlg, ...dlg.querySelectorAll('*')]) {
        if (el.scrollHeight - el.clientHeight > 4 && el.clientHeight > 100) { scroller = el; break; }
      }
      if (!scroller) return { hidden: 0 };
      const cs = getComputedStyle(scroller);
      return {
        hidden: scroller.scrollHeight - scroller.clientHeight,
        // A cue AT THE SCROLLING EDGE. Deliberately not `boxShadow`: the first
        // version of this check accepted one, and passed on the modal's own
        // drop shadow while 156px of the sheet was still cut off with nothing
        // to show for it. An elevation shadow is not a scroll affordance.
        mask: cs.maskImage !== 'none',
        bgImage: cs.backgroundImage !== 'none',
        cls: (scroller.className ?? '').toString().slice(0, 40),
      };
    });

    expect(state, 'no dialog opened').not.toBeNull();
    expect(
      state!.hidden,
      'the sheet fits this window, so this check has no overflow to detect',
    ).toBeGreaterThan(0);
    expect(
      state!.mask || state!.bgImage,
      `${state!.hidden}px of the sheet is hidden below the fold and nothing at its edge says so (.${state!.cls})`,
    ).toBe(true);
  });
});
