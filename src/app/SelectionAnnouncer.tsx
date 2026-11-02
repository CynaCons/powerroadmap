import { useDocumentStore } from '../stores/documentStore';
import { useSelectionStore, selectionSubjects } from '../stores/selectionStore';

/**
 * What is selected, said out loud (SRS-EDIT-086).
 *
 * Nine ordinary actions were measured against a MutationObserver on every
 * live region in the app, and eight of them announced nothing at all: picking
 * a bar, adding a second, nudging, undoing, changing the scale, zooming. The
 * status bar holds the count, but it is not a live region, so a screen-reader
 * user got the chart's state only by hunting for it.
 *
 * This is deliberately NOT the notice channel. A notice is something the app
 * has done and shows a toast for; a selection change happens on every arrow
 * press and must be quiet — a polite region, no toast, nothing drawn.
 */
export function SelectionAnnouncer() {
  const items = useSelectionStore((s) => s.items);
  const doc = useDocumentStore((s) => s.doc);

  const picked = selectionSubjects(items);
  let said = '';

  if (picked.length === 1) {
    const only = picked[0];
    const named =
      only.kind === 'task' ? doc.tasks.find((t) => t.id === only.id)
      : only.kind === 'milestone' ? doc.milestones.find((m) => m.id === only.id)
      : only.kind === 'marker' ? doc.markers.find((m) => m.id === only.id)
      : only.kind === 'bracket' ? doc.brackets.find((b) => b.id === only.id)
      : only.kind === 'row' ? doc.rows.find((r) => r.id === only.id)
      : undefined;
    const label = named && 'label' in named ? named.label : null;
    // The dates are the point of a Gantt chart, so a selected bar says when
    // it runs rather than only what it is called.
    const span =
      only.kind === 'task' && named && 'start' in named ? `, ${named.start} to ${named.end}`
      : only.kind === 'milestone' && named && 'date' in named ? `, ${named.date}`
      : '';
    said = label ? `${only.kind} selected: ${label}${span}` : `${only.kind} selected`;
  } else if (picked.length > 1) {
    said = `${picked.length} items selected`;
  }

  return (
    <span className="sr-only" role="status">
      {said}
    </span>
  );
}
