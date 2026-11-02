import { useEffect } from 'react';
import { resolve } from './keymap';
import { anyModalOpen } from '../stores/viewStore';

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/**
 * Keys the focused control answers itself (SRS-EDIT-089).
 *
 * Enter is bound to "open details", so this hook resolved it, called
 * `preventDefault()` and the browser never activated the button the user had
 * tabbed to. Measured on three of them — the header's Settings, the header's
 * Snap and a panel section head — Enter fired zero click events and the
 * keydown came back `defaultPrevented: true`. A keyboard user could reach
 * every control in the chrome and press none of them.
 *
 * Space is here for the same reason: it activates a focused button natively,
 * and a global binding that swallowed it would break the same way.
 */
function isNativeActivation(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return false;
  const t = e.target;
  if (!(t instanceof HTMLElement)) return false;
  return !!t.closest(
    'button, a[href], summary, [role="button"], [role="menuitem"], [role="radio"], ' +
      '[role="tab"], [role="option"], [role="checkbox"], [role="switch"]',
  );
}

/**
 * The whole global keyboard, in one dispatch (SRS-EDIT-040).
 *
 * Everything this hook knows is in `keymap.ts`. Here there are only the three
 * questions that are about the page rather than about a binding: is the user
 * typing into a field, does a dialog or sheet own the keyboard, and did any
 * binding claim this chord. An unclaimed chord runs nothing and — this is the
 * part that matters — preventDefaults nothing, so Ctrl+N is the browser's
 * "new" again and Alt+← is Back again.
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Before anything else: a control that has focus owns its own activation
      // keys. Claiming them here is how Enter stopped pressing buttons.
      if (isNativeActivation(e)) return;

      const binding = resolve(e);
      if (!binding) return;

      if (!binding.whileTyping && isEditableTarget(e.target)) return;

      // A dialog or a teaching sheet owns the keyboard while it is open; only
      // the chords declared 'always' (save, the palette, the sheet's own
      // toggle) get through. Without this, M inserted a milestone on row one
      // while the user was reading the shortcuts sheet that lists M.
      if (binding.when !== 'always' && anyModalOpen()) return;

      if (binding.preventDefault !== false) e.preventDefault();
      binding.run();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
