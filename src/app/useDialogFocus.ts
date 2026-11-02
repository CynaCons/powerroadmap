import { useEffect, type RefObject } from 'react';

/**
 * A dialog takes focus when it opens, keeps it while it is open, and gives it
 * back when it closes (SRS-LAY-058).
 *
 * Measured on v2.34.2: opening the shortcuts sheet left `document.activeElement`
 * on BODY, and ten Tab presses put focus outside the dialog ten times out of
 * ten — on the header and the side panel, under a scrim, where a sighted
 * pointer user could not see what was focused and a screen-reader user was
 * reading a page they had supposedly left. The Settings dialog behaved the
 * same. The command palette has always done this correctly; this is that
 * behaviour, extracted so the other dialogs cannot drift from it.
 *
 * Escape is deliberately NOT handled here: the keymap already owns it, and two
 * owners would close two layers on one press.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, open = true): void {
  useEffect(() => {
    if (!open) return;
    const panel = ref.current;
    if (!panel) return;

    const previously = document.activeElement as HTMLElement | null;

    const focusables = () =>
      [...panel.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )].filter((el) => el.offsetParent !== null || el === document.activeElement);

    // The panel itself takes focus when it holds nothing focusable, so that a
    // screen reader lands inside the dialog rather than wherever it was.
    const first = focusables()[0];
    if (first) first.focus();
    else {
      panel.setAttribute('tabindex', '-1');
      panel.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      // Wrap at both ends, and catch the case where focus has already escaped.
      if (!panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? lastItem : firstItem).focus();
      } else if (e.shiftKey && active === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && active === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Back where it came from, if that is still somewhere focus can go.
      if (previously && document.contains(previously)) previously.focus();
    };
  }, [ref, open]);
}
