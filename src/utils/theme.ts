import type { ThemeName } from '../types/document';

/**
 * The theme a NEW document starts in (SRS-THEME-005).
 *
 * The theme is a property of the document, not of the app: a chart carries its
 * own look into the file so that opening someone else's plan shows you what
 * they saw. That rule is right, and it is why this is not a `prefers-color-scheme`
 * block in the stylesheet — a media query would repaint a document that had
 * explicitly chosen light, which is the one thing the format promises not to do.
 *
 * But a document that has never chosen anything is a different case, and the
 * app was answering it with a hardcoded 'light': a planner whose machine is in
 * dark mode opened a white window every time (post-release report, v2.34.1).
 * So the OS is consulted exactly once, when the document is created, and the
 * answer is written into the document like any other choice the user could
 * have made themselves. Saving it is the point: the file still states its own
 * theme, and nothing re-decides it later.
 *
 * Guarded, because this is evaluated at module load in the template file and
 * `matchMedia` is absent under jsdom.
 */
export function initialTheme(): ThemeName {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  } catch {
    return 'light';
  }
}
