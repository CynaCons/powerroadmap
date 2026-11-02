import { describe, it, expect, afterEach, vi } from 'vitest';
import { initialTheme } from '../../src/utils/theme';

/**
 * SRS-THEME-005 — a document that has never chosen a theme starts in the one
 * the machine asks for.
 *
 * Nineteen versions opened white on a dark desktop because this answer was the
 * literal `'light'` in six document factories.
 */
describe('initialTheme', () => {
  const stub = (matches: boolean) =>
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('dark') && matches }));

  afterEach(() => vi.unstubAllGlobals());

  it('is dark when the OS asks for dark', () => {
    stub(true);
    expect(initialTheme()).toBe('dark');
  });

  it('is light when it does not', () => {
    stub(false);
    expect(initialTheme()).toBe('light');
  });

  it('asks about the colour scheme and nothing else', () => {
    const seen: string[] = [];
    vi.stubGlobal('matchMedia', (q: string) => {
      seen.push(q);
      return { matches: false };
    });
    initialTheme();
    expect(seen).toEqual(['(prefers-color-scheme: dark)']);
  });

  it('falls back to light where there is no matchMedia at all', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(initialTheme()).toBe('light');
  });

  it('falls back to light when matchMedia throws', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('not supported');
    });
    expect(initialTheme()).toBe('light');
  });
});

describe('the document factories ask rather than assume', () => {
  it('no factory hardcodes a theme any more', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['src/utils/sample.ts', 'src/utils/templates.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f} still names a theme outright`).not.toMatch(/theme:\s*'(light|dark)'/);
      expect(src).toContain('theme: initialTheme()');
    }
  });
});
