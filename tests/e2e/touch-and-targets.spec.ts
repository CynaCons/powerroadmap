import { test, expect, type Page } from '@playwright/test';

/**
 * SRS-EDIT-085 and SRS-EDIT-087 — the chart under a finger.
 *
 * The drag loop was built on `mousedown` plus a window `mousemove`: 15 such
 * sites and no `pointerdown`, `setPointerCapture` or `touch-action` anywhere
 * in `src/`. Measured before the fix, on an 820x1180 touch context: ten touch
 * moves across 120px left the bar exactly where it started, while the same
 * drag with a MOUSE in the same browser context moved it 122.6px. The product
 * ships into an Office task pane and onto tablets, and its primary verb did
 * not answer a finger.
 *
 * The mouse control is not decoration: without it, a touch test that fails
 * because the selector is wrong looks identical to one that fails because the
 * feature is missing.
 */

const barGeom = (page: Page) =>
  page.evaluate(() => {
    const b = document.querySelector('.task-bar-body')!.getBoundingClientRect();
    return { x: +b.x.toFixed(1), w: +b.width.toFixed(1) };
  });

const ready = async (page: Page) => {
  await page.goto('/');
  await page.locator('.chart-area svg').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('.task-bar-body').length > 0);
  await page.waitForTimeout(800);
};

test.describe('a bar moves under a finger (SRS-EDIT-085)', () => {
  // Only the capability, not a whole device descriptor: a descriptor
  // carries `defaultBrowserType`, which Playwright refuses inside a describe.
  test.use({ hasTouch: true, viewport: { width: 820, height: 1180 } });

  test('a touch drag moves the bar, and a mouse drag in the same page also does', async ({ page }) => {
    await ready(page);
    const before = await barGeom(page);
    const b = await page.locator('.task-bar-body').first().boundingBox();
    const y = b!.y + b!.height / 2;

    // A finger: down, several moves, up.
    //
    // Real touch input through CDP where it exists, which is the strongest
    // form of this check — but CDP is Chromium-only and the tablet project
    // runs WebKit, which is the engine an actual iPad uses. So elsewhere the
    // same gesture is dispatched in-page as pointer events carrying
    // `pointerType: 'touch'`, which is exactly the stream a finger produces
    // and exactly what the app listens for.
    const browserName = test.info().project.use.defaultBrowserType ?? 'chromium';
    const startX = b!.x + b!.width / 2;
    if (browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y }] });
      for (let i = 1; i <= 10; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX + i * 12, y }] });
        await page.waitForTimeout(20);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await page.evaluate(
        ({ x, y: cy }) => {
          const target = document.elementFromPoint(x, cy)!;
          const ev = (type: string, cx: number) =>
            new PointerEvent(type, {
              bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch',
              isPrimary: true, clientX: cx, clientY: cy, button: 0, buttons: 1,
            });
          target.dispatchEvent(ev('pointerdown', x));
          for (let i = 1; i <= 10; i++) window.dispatchEvent(ev('pointermove', x + i * 12));
          window.dispatchEvent(ev('pointerup', x + 120));
        },
        { x: startX, y },
      );
    }
    await page.waitForTimeout(600);
    const afterTouch = await barGeom(page);
    const touchMoved = afterTouch.x - before.x;

    // The control, in the same context: if this does not move either, the test
    // is broken rather than the app.
    const b2 = await page.locator('.task-bar-body').first().boundingBox();
    await page.mouse.move(b2!.x + b2!.width / 2, y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(b2!.x + b2!.width / 2 + i * 12, y);
    await page.mouse.up();
    await page.waitForTimeout(600);
    const afterMouse = await barGeom(page);
    const mouseMoved = afterMouse.x - afterTouch.x;

    expect(Math.abs(mouseMoved), `the mouse control did not move the bar either (${mouseMoved.toFixed(1)}px) — this test proves nothing`).toBeGreaterThan(20);
    expect(Math.abs(touchMoved), `a ten-step touch drag moved the bar ${touchMoved.toFixed(1)}px`).toBeGreaterThan(20);
  });

  test('the plot does not let the browser pan away the gesture', async ({ page }) => {
    await ready(page);
    const touchAction = await page.evaluate(() => {
      const svg = document.querySelector('.chart-area svg')!;
      return { svg: getComputedStyle(svg).touchAction, area: getComputedStyle(document.querySelector('.chart-area')!).touchAction };
    });
    expect(
      [touchAction.svg, touchAction.area],
      `touch-action is ${JSON.stringify(touchAction)} — the browser will scroll instead of dragging`,
    ).toContain('none');
  });
});

/**
 * SRS-EDIT-087 — WCAG 2.2 SC 2.5.8 Target Size (Minimum), Level AA: 24x24 CSS
 * px unless the Spacing exception applies, and it does not here — these sit
 * against one another. Measured before the fix: resize grip hit over 7x22,
 * dependency anchor 10x10 with no enlarged hit area at all, progress handle
 * 10x22, and a 4px band between a bar's end and its label where nothing
 * answered a press.
 */
test.describe('the chart handles are big enough to hit (SRS-EDIT-087)', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 900, 'needs a desktop chart');

  test('every handle on a selected bar is hit-testable over at least 24px', async ({ page }) => {
    await ready(page);
    await page.locator('.task-bar-body').first().click();
    await page.waitForTimeout(500);

    const handles = await page.evaluate(() => {
      // Measure the element the app itself hit-tests against — the one
      // carrying the data attributes — not whatever `elementFromPoint`
      // happens to return. The chart resolves a press with
      // `elementsFromPoint` plus `hitRank`, so the topmost element at a point
      // is NOT what takes the gesture: a bar's label sits over its anchor and
      // still loses to it on rank.
      const pairs: { name: string; drawnSel: string; hitSel: string }[] = [
        { name: '.bar-grip', drawnSel: '.bar-grip', hitSel: '[data-pp-kind="task"][data-pp-sub="end"]' },
        { name: '.bar-anchor', drawnSel: '.bar-anchor', hitSel: '[data-pp-kind="connector"][data-pp-sub="end"]' },
        { name: '.bar-progress-handle', drawnSel: '.bar-progress-handle', hitSel: '[data-pp-kind="task"][data-pp-sub="progress"]' },
      ];
      const box = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
      };
      return pairs
        .map((p) => ({ name: p.name, drawn: box(p.drawnSel), hit: box(p.hitSel) }))
        .filter((p): p is { name: string; drawn: { w: number; h: number }; hit: { w: number; h: number } } =>
          p.drawn !== null && p.hit !== null);
    });

    expect(handles.length, 'no handles were rendered on a selected bar').toBe(3);

    // Vertically there is always room, so 24px is simply required.
    const tooShort = handles.filter((h) => !h.hit || h.hit.h < 24);
    expect(
      tooShort.map((h) => `${h.name} hit ${h.hit?.w}x${h.hit?.h}`),
      'these handles are under 24px tall, where nothing competes for the space',
    ).toEqual([]);

    // Horizontally, only the anchor stands clear of its neighbours; a grip or
    // the progress handle is bounded by its own bar, and widening it inward
    // would eat the body that carries the rename (SRS-EDIT-087). What is
    // required of those is that they reach outward rather than stay at their
    // drawn width — 7px and 8px, which is what they used to be hit over.
    const anchors = handles.filter((h) => h.name === '.bar-anchor');
    expect(anchors.length, 'no dependency anchors were rendered').toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a.hit!.w, `an anchor stands clear of everything and is hit over only ${a.hit!.w}px`).toBeGreaterThanOrEqual(24);
    }
    const bounded = handles.filter((h) => h.name !== '.bar-anchor');
    for (const h of bounded) {
      expect(
        h.hit!.w,
        `${h.name} is hit over ${h.hit!.w}px, no wider than the ${h.drawn.w}px mark it draws`,
      ).toBeGreaterThan(h.drawn.w * 1.5);
    }
  });

  test('there is no dead band between a bar and its label', async ({ page }) => {
    await ready(page);
    await page.locator('.task-bar-body').first().click();
    await page.waitForTimeout(400);
    const dead = await page.evaluate(() => {
      const b = document.querySelector('.task-bar-body')!.getBoundingClientRect();
      const y = b.y + b.height / 2;
      const gaps: number[] = [];
      for (let dx = 0; dx <= 24; dx++) {
        const el = document.elementFromPoint(b.right + dx, y);
        if (!el?.closest('[data-pp-kind]')) gaps.push(dx);
      }
      return gaps;
    });
    expect(dead, `nothing answers a press at +${dead.join(', +')}px past the bar's end`).toEqual([]);
  });
});
