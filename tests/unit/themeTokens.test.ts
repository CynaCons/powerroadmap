import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * SRS-THEME-007 — today and a deadline are told apart by colour.
 *
 * `--color-today` and `--color-deadline` were the same `#B3382C` in every
 * theme, so the line that says "now" and the lines that say "this is due"
 * differed only in that one was dashed. A reader scanning a dense plot has to
 * measure the dash to know which is which, and an exported or printed chart
 * loses the dash before it loses the hue.
 *
 * Difference is measured in CIE Lab rather than by comparing hex strings,
 * because two reds can differ in their notation and not to the eye. ΔE*ab of
 * about 2.3 is the just-noticeable step; the threshold here is well past it
 * while leaving both colours free to stay in the same warm family.
 */

const CSS = readFileSync('src/styles/global.css', 'utf8');

/** The token blocks that define a whole palette. */
const BLOCKS = [
  { name: 'light (:root)', selector: ':root' },
  { name: "light ([data-theme='light'])", selector: "[data-theme='light']" },
  { name: "dark ([data-theme='dark'])", selector: "[data-theme='dark']" },
  { name: "print ([data-theme='print'])", selector: "[data-theme='print']" },
];

function blockOf(selector: string): string {
  const i = CSS.indexOf(`\n${selector} {`);
  expect(i, `no ${selector} block in global.css`).toBeGreaterThan(-1);
  const start = CSS.indexOf('{', i);
  const end = CSS.indexOf('\n}', start);
  return CSS.slice(start, end);
}

function token(block: string, name: string): string | null {
  const m = block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

const hex = (s: string) => {
  const m = s.match(/#([0-9a-f]{6})/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

/** sRGB → CIE Lab (D65), enough for a ΔE*ab. */
function lab({ r, g, b }: { r: number; g: number; b: number }) {
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return { L: 116 * fy - 16, a: 500 * (fx - fy), bb: 200 * (fy - fz) };
}

const deltaE = (p: string, q: string) => {
  const A = hex(p), B = hex(q);
  if (!A || !B) return null;
  const x = lab(A), y = lab(B);
  return Math.sqrt((x.L - y.L) ** 2 + (x.a - y.a) ** 2 + (x.bb - y.bb) ** 2);
};

describe('today and a deadline are different colours (SRS-THEME-007)', () => {
  for (const { name, selector } of BLOCKS) {
    it(`in ${name}`, () => {
      const block = blockOf(selector);
      const today = token(block, '--color-today');
      const deadline = token(block, '--color-deadline');
      // A block that defines neither is not a palette block and is a bug in
      // this test, not in the stylesheet.
      expect(today, `${selector} defines no --color-today`).toBeTruthy();
      expect(deadline, `${selector} defines no --color-deadline`).toBeTruthy();
      expect(deadline, `${selector}: a deadline is painted in the TODAY colour`).not.toBe(today);

      const d = deltaE(today!, deadline!);
      expect(d, `could not read ${today} / ${deadline} as hex`).not.toBeNull();
      expect(
        d!,
        `${selector}: today ${today} and deadline ${deadline} are ΔE ${d!.toFixed(1)} apart — too close to tell apart`,
      ).toBeGreaterThan(12);
    });
  }

  it('the measurement can tell two near-identical colours apart from two distinct ones', () => {
    // Without this, a ΔE that always returned a large number would pass the
    // whole file.
    expect(deltaE('#B3382C', '#B3382C')).toBe(0);
    expect(deltaE('#B3382C', '#B4392D')!).toBeLessThan(2);
    expect(deltaE('#B3382C', '#C07A14')!).toBeGreaterThan(12);
  });
});
