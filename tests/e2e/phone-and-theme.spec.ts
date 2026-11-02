import { test, expect, type Page } from '@playwright/test';

/**
 * SRS-LAY-053, SRS-LAY-054, SRS-TAX-026, SRS-THEME-005, SRS-THEME-006.
 *
 * Five things post-release testing found in v2.34.1, none of which any gate
 * could have caught: every one is about what the app LOOKS like at a size or
 * in a theme the suite never opened it at. A type-check, a lint and 435 unit
 * tests all passed over the header that was painting its toolbar across its
 * own wordmark.
 *
 * So these assert measured geometry and measured colour, and each one carries
 * the number it observed into its failure message. They were written against
 * the broken build first: the figures in the comments are what they reported
 * before the fix.
 */

const ready = async (page: Page) => {
  await page.goto('/');
  await page.locator('.chart-area svg').first().waitFor({ state: 'visible' });
  // The gutter measures its own names on a layout pass after mount.
  await page.waitForFunction(() => document.querySelectorAll('[data-pp-kind="row"]').length > 0);
};

/* ------------------------------------------------------------------ *
 * The phone
 * ------------------------------------------------------------------ */

test.describe('the header on a phone (SRS-LAY-054)', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > 560, 'about the narrow header');

  test('the brand stays inside the brand, and nothing is drawn over it', async ({ page }) => {
    await ready(page);

    const seen = await page.evaluate(() => {
      const brand = document.querySelector('.app-header .brand')!;
      const logo = brand.querySelector('svg')!;
      const toolbar = document.querySelector('.app-header .toolbar')!;
      const l = logo.getBoundingClientRect();
      const t = toolbar.getBoundingClientRect();
      // Geometry is not enough on its own: the toolbar paints its own
      // background, so "is the mark the thing under the pointer" is the
      // question a reader would actually ask.
      const covered: string[] = [];
      for (let i = 0; i < 9; i++) {
        const hit = document.elementFromPoint(l.left + (l.width * (i + 0.5)) / 9, l.top + l.height / 2);
        if (hit && !brand.contains(hit)) covered.push(hit.tagName);
      }
      return {
        overlap: +Math.max(0, l.right - t.left).toFixed(1),
        covered: covered.length,
        markWidth: +l.width.toFixed(1),
        titleWidth: +(document.querySelector('.title-chip')?.getBoundingClientRect().width ?? 0).toFixed(1),
      };
    });

    // Was: 114.5px past the toolbar's left edge, 7 of 9 samples covered.
    expect(seen.overlap, `${seen.overlap}px of the mark lies under the toolbar`).toBe(0);
    expect(seen.covered, `${seen.covered}/9 points on the mark hit something else`).toBe(0);
    // The wordmark is cropped to the symbol rather than scaled down to a smudge.
    expect(seen.markWidth).toBeLessThanOrEqual(28);
    expect(seen.markWidth).toBeGreaterThanOrEqual(20);
    // And the width that frees goes to the document's name.
    expect(seen.titleWidth, 'the name got none of the room the wordmark gave up').toBeGreaterThan(40);
  });
});

test.describe('row names on a phone (SRS-LAY-053)', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > 560, 'the panel is only clamped when narrow');

  test('no row name is drawn outside the row panel', async ({ page }) => {
    await ready(page);

    const seen = await page.evaluate(() => {
      const svg = document.querySelector('.chart-area svg')!;
      // The divider the chart draws is the boundary a reader sees; the CSS
      // variable is only what it was asked to draw.
      const divider = [...svg.querySelectorAll(':scope > line')].find(
        (l) => l.getAttribute('x1') === l.getAttribute('x2'),
      )!;
      const edge = divider.getBoundingClientRect().left;
      const texts = [...document.querySelectorAll('g[data-pp-kind="row"] text')];
      let worst = 0;
      let worstLabel = '';
      const over = texts.filter((t) => {
        const spill = t.getBoundingClientRect().right - edge;
        if (spill > worst) {
          worst = spill;
          worstLabel = t.textContent ?? '';
        }
        return spill > 0.5;
      });
      return { total: texts.length, over: over.length, worst: +worst.toFixed(1), worstLabel };
    });

    expect(seen.total, 'no row names were found at all').toBeGreaterThan(5);
    // Was: 28 of 39 across the divider, the worst by 97.3px.
    expect(seen.over, `${seen.over}/${seen.total} names cross the divider, worst "${seen.worstLabel}" by ${seen.worst}px`).toBe(0);
  });

  test('a name that had to be cut keeps its full text on hover', async ({ page }) => {
    await ready(page);
    const cut = page.locator('g[data-pp-kind="row"] text').filter({ hasText: '…' }).first();
    await expect(cut, 'nothing was truncated, so there is nothing to check').toBeVisible();
    // An SVG <text> is not an HTMLElement, and its `textContent` would swallow
    // the <title> we are comparing against — so read the text nodes alone.
    const { shown, full } = await cut.evaluate((el) => ({
      shown: [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim(),
      full: (el.querySelector('title')?.textContent ?? '').trim(),
    }));
    expect(shown).toMatch(/…$/);
    expect(full.length, `"${shown}" claims to stand for "${full}"`).toBeGreaterThan(shown.length);
    expect(full.startsWith(shown.replace(/…$/, '').trim())).toBe(true);
  });

  test('a name drawn in full carries no tooltip repeating it', async ({ page }) => {
    await ready(page);
    // The first attempt gave every name a <title>, cut or not. A <title> is a
    // second copy of the name in the text tree: `text=Stakeholder requirements`
    // then resolved to the invisible one, and a screen reader read each row
    // twice. Four e2e specs went red on it, which is the only reason it was
    // caught — so it is worth a test of its own.
    const echoed = await page.evaluate(() =>
      [...document.querySelectorAll('g[data-pp-kind="row"] text')].filter((el) => {
        const drawn = [...el.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent ?? '')
          .join('')
          .trim();
        const title = el.querySelector('title')?.textContent?.trim();
        return title !== undefined && title === drawn;
      }).length,
    );
    expect(echoed, `${echoed} row names carry a tooltip saying what is already drawn`).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The calendar
 * ------------------------------------------------------------------ */

test('axis labels never touch each other (SRS-TAX-026)', async ({ page }) => {
  await ready(page);

  const seen = await page.evaluate(() => {
    const bands = [...document.querySelectorAll('[data-pp-axis]')];
    let worst = 0;
    let pair = '';
    let pairs = 0;
    let labels = 0;
    for (const band of bands) {
      const items = [...band.querySelectorAll('text')]
        .filter((t) => (t.textContent ?? '').trim())
        .map((t) => ({ text: t.textContent ?? '', r: t.getBoundingClientRect() }))
        .sort((a, b) => a.r.left - b.r.left);
      labels += items.length;
      for (let i = 1; i < items.length; i++) {
        pairs++;
        const gap = items[i].r.left - items[i - 1].r.right;
        if (-gap > worst) {
          worst = -gap;
          pair = `"${items[i - 1].text}" / "${items[i].text}"`;
        }
      }
    }
    return { worst: +worst.toFixed(1), pair, pairs, labels, bands: bands.length };
  });

  // An axis with nothing on it would otherwise pass this for free.
  expect(seen.bands, 'no axis bands were found').toBeGreaterThanOrEqual(2);
  expect(seen.pairs, `only ${seen.labels} labels, too few to compare`).toBeGreaterThanOrEqual(4);
  // Was: "Feb 2026" over "Mar" by 4px at 1440, by 6.6px at 390.
  expect(seen.worst, `${seen.pair} overlap by ${seen.worst}px`).toBeLessThanOrEqual(0.5);
});

/* ------------------------------------------------------------------ *
 * The themes
 * ------------------------------------------------------------------ */

/**
 * Worst contrast among the panel's own labels, against whatever is actually
 * painted behind each one.
 */
const worstPanelContrast = (page: Page) =>
  page.evaluate(() => {
    const chan = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    type RGBA = { r: number; g: number; b: number; a: number };
    const parse = (s: string): RGBA | null => {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const lum = ({ r, g, b }: RGBA) => 0.2126 * chan(r / 255) + 0.7152 * chan(g / 255) + 0.0722 * chan(b / 255);
    const over = (fg: RGBA, bg: RGBA): RGBA => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const ratio = (a: RGBA, b: RGBA) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const behind = (el: Element): RGBA => {
      let n: Element | null = el;
      let acc: RGBA | null = null;
      while (n && n !== document.documentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) acc = acc ? over(acc, c) : c;
        if (acc && acc.a >= 1) return acc;
        n = n.parentElement;
      }
      const root = parse(getComputedStyle(document.documentElement).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
      return acc ? over(acc, root) : root;
    };

    const panel = document.querySelector('.cmdbar');
    if (!panel) return { count: 0, worst: null as null | { text: string; ratio: number; need: number } };
    let worst: { text: string; ratio: number; need: number } | null = null;
    let count = 0;
    for (const el of panel.querySelectorAll('*')) {
      if (![...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim())) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.visibility === 'hidden' || r.width < 1 || r.height < 1) continue;
      const fg = parse(cs.color);
      if (!fg) continue;
      const bg = behind(el);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (Number(cs.fontWeight) >= 700 && size >= 18.66);
      const seen = {
        text: (el.textContent ?? '').trim().slice(0, 24),
        ratio: +ratio(over(fg, bg), bg).toFixed(2),
        need: large ? 3 : 4.5,
      };
      count++;
      // Rank by how far under its own threshold it is, not by raw ratio.
      if (!worst || seen.ratio - seen.need < worst.ratio - worst.need) worst = seen;
    }
    return { count, worst };
  });

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`with the OS set to ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    test(`a new document opens in ${scheme} (SRS-THEME-005)`, async ({ page }) => {
      await ready(page);
      const seen = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme ?? null,
        shell: getComputedStyle(document.querySelector('.app-shell')!).backgroundColor,
      }));
      // Asserted in both directions on purpose: a check that says "dark" on a
      // light machine too would be measuring nothing.
      expect(seen.theme, `the app chose "${seen.theme}" with the OS on ${scheme}`).toBe(scheme);
      const n = seen.shell.match(/\d+/g)!.map(Number);
      const light = (n[0] + n[1] + n[2]) / 3 > 128;
      expect(light, `the shell is painted ${seen.shell}`).toBe(scheme === 'light');
    });

    test(`the panel's labels meet AA in ${scheme} (SRS-THEME-006)`, async ({ page }) => {
      await ready(page);
      const { count, worst } = await worstPanelContrast(page);
      expect(count, 'no panel labels were found to measure').toBeGreaterThan(4);
      // Was: the four section headings at 3.00:1 against a 4.5:1 threshold.
      expect(
        worst!.ratio,
        `"${worst!.text}" is ${worst!.ratio}:1 and needs ${worst!.need}:1`,
      ).toBeGreaterThanOrEqual(worst!.need);
    });
  });
}
