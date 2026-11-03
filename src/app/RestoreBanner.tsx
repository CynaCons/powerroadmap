import { X } from 'lucide-react';

interface Props {
  onRestore: () => void;
  onDismiss: () => void;
}

/**
 * The offer to restore an unsaved session (SRS-PERS-030).
 *
 * It used to be an inline-styled box at `top: 8`, which put it over the header.
 * On a desktop that missed the controls by luck — the box is centred and narrow,
 * and the buttons sit at the right edge. On a 375px phone it wraps to 187×114
 * and lands squarely on the Settings gear: measured with `elementFromPoint` on
 * the gear's own centre, the answer was this banner. So the one control that now
 * leads to every preference, the agent bridge included, could not be reached on
 * a phone until the banner was dismissed — and the banner is the first thing a
 * returning planner sees. It sits below the header now, at every width.
 */
export function RestoreBanner({ onRestore, onDismiss }: Props) {
  return (
    <div className="restore-banner" role="alert">
      <span>An unsaved session from your last visit is available.</span>
      <button onClick={onRestore} className="primary restore-banner__restore">
        Restore
      </button>
      <button onClick={onDismiss} aria-label="Dismiss" className="restore-banner__dismiss">
        <X size={14} />
      </button>
    </div>
  );
}
