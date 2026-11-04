import { useMemo, useState, memo } from 'react';
import type { Row } from '../types/document';
import { useDocumentStore } from '../stores/documentStore';
import { useIsSelected } from '../stores/selectionStore';
import { InlineLabel } from '../app/InlineLabel';
import { truncateToGutter, X_CHILD, X_GROUP, X_TOP, RIGHT_PAD } from '../layout/gutterWidth';

interface Props {
  rows: Row[];
  rowHeights: number[];
  rowOffsets: number[];
  width: number;
}

/**
 * The row gutter reads as a hierarchy, not a list.
 *
 * It used to render every row at the same size with the same hairline under
 * it, so a 35-row programme arrived as 35 equal lines and the eye had nothing
 * to hold onto (owner report 2026-10-23: "the left side is a bit meh, not so
 * clear"). Now a group carries a colour spine in its own stream colour and its
 * packages sit indented and lighter beneath it.
 *
 * The spine colour is taken from the group's own tasks rather than stored on
 * the row, so it can never disagree with the bars it labels.
 */
function RowGutterInner({ rows, rowHeights, rowOffsets, width }: Props) {
  const updateRow = useDocumentStore((s) => s.updateRow);
  const moveRow = useDocumentStore((s) => s.moveRow);
  const isSelected = useIsSelected();
  // Renaming belongs here, on the name itself, not in the bottom bar — the bar
  // is for quick actions (owner directive 2026-10-26).
  const [editing, setEditing] = useState<string | null>(null);
  const allRows = useDocumentStore((s) => s.doc.rows);
  const tasks = useDocumentStore((s) => s.doc.tasks);
  /**
   * Reordering by hand (SRS-EDIT-091).
   *
   * `move_row` already existed and already carried a section's children with
   * it — the only thing missing was a way to reach it that is not a menu. The
   * drop target is held in VISIBLE-row terms while dragging, because that is
   * what the planner is looking at, and converted to the operation's own index
   * on release.
   *
   * Pointer events rather than mouse events, so a finger reorders rows as well
   * as a mouse does; the gutter sets `touch-action: none` or the browser
   * claims the gesture as a pan before the first move is seen.
   */
  const [drag, setDrag] = useState<{ id: string; at: number | null } | null>(null);

  const { childCount, groupColor } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of allRows) {
      if (r.groupId) counts.set(r.groupId, (counts.get(r.groupId) ?? 0) + 1);
    }
    // rowId -> its group's id, so a task can colour the group it belongs to.
    const parentOf = new Map<string, string>();
    for (const r of allRows) if (r.groupId) parentOf.set(r.id, r.groupId);

    const colors = new Map<string, string>();
    for (const t of tasks) {
      const parent = parentOf.get(t.rowId);
      if (parent && t.color && !colors.has(parent)) colors.set(parent, t.color);
    }
    return { childCount: counts, groupColor: colors };
  }, [allRows, tasks]);

  const beginDrag = (e: React.PointerEvent, id: string, i: number) => {
    if (e.button !== 0 || editing === id) return;
    // Screen y of this group's local origin, so the pointer can be read in the
    // same coordinates the row offsets are written in — the gutter is inside a
    // scrolled, translated group and no other mapping survives a scroll.
    const box = (e.currentTarget as SVGGElement).getBoundingClientRect();
    const originY = box.top - rowOffsets[i];
    const startY = e.clientY;
    let moved = false;
    let at: number | null = null;

    const boundary = (clientY: number): number => {
      const localY = clientY - originY;
      for (let k = 0; k < rows.length; k++) {
        if (localY < rowOffsets[k] + rowHeights[k] / 2) return k;
      }
      return rows.length;
    };

    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
      moved = true;
      at = boundary(ev.clientY);
      setDrag({ id, at });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
      setDrag(null);
      if (!moved || at === null) return;
      // The operation indexes into the rows that REMAIN once the moving ones
      // are lifted out, which is what `move_row` does with them. A section
      // takes its children, so they leave the list too.
      const to = dropIndex(allRows, rows, id, at);
      if (to !== null) moveRow(id, to);
    };
    // Escape abandons the gesture and writes nothing, as everywhere else.
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      moved = false;
      up();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
  };

  // Each name cut to the gutter it has to fit in. Memoised on purpose: this
  // component re-renders on every scroll frame, and the fit is a binary search
  // over canvas measurements per row.
  const fitted = useMemo(() => {
    const out = new Map<string, string>();
    for (const row of rows) {
      const group = (childCount.get(row.id) ?? 0) > 0;
      const x = group ? X_GROUP : row.groupId ? X_CHILD : X_TOP;
      out.set(row.id, truncateToGutter(row.label, width - x - RIGHT_PAD, group ? 12 : 11, group));
    }
    return out;
  }, [rows, width, childCount]);

  return (
    <g>
      {rows.map((row, i) => {
        const isGroup = (childCount.get(row.id) ?? 0) > 0;
        const h = rowHeights[i];
        const spine = groupColor.get(row.id) ?? 'var(--color-text-soft)';
        // The editor's field is 0.92 alpha, not opaque, so the name underneath
        // ghosted through it and the user read two names at once — the one
        // being typed and the one being replaced (SRS-EDIT-051). The spine and
        // the collapse chevron stay: they are structure, not the value.
        const renaming = editing === row.id;

        return (
          // The data attributes live on the GROUP, not on the backing rect:
          // the right-click handler resolves its target with `closest()`, which
          // walks ancestors, and the label text sits as a sibling of the rect
          // rather than inside it.
          <g
            key={row.id}
            data-pp-kind="row"
            data-pp-id={row.id}
            data-pp-selected={isSelected(row.id) ? '1' : undefined}
            transform={`translate(0 ${rowOffsets[i]})`}
            onDoubleClick={() => setEditing(row.id)}
            onPointerDown={(e) => beginDrag(e, row.id, i)}
            // The row selects on a click, renames on a double-click and now
            // reorders on a drag, so the default arrow was telling the user
            // there was nothing here. `touch-action: none` or the browser pans
            // the chart instead of handing us the gesture.
            style={{
              cursor: drag?.id === row.id ? 'grabbing' : 'pointer',
              touchAction: 'none',
              opacity: drag?.id === row.id ? 0.45 : 1,
            }}
          >
            <rect
              x={0}
              y={0}
              width={width}
              height={h}
              // The band is drawn once, across the whole sheet, by `Rows`
              // (SRS-EDIT-024). Tinting the gutter cell here as well would
              // double the wash over exactly the part the band already covers.
              fill="transparent"
            />

            {isGroup ? (
              <>
                <rect x={10} y={h / 2 - 7} width={3} height={14} fill={spine} />
                <g
                  onClick={() => updateRow(row.id, { collapsed: !row.collapsed })}
                  style={{ cursor: 'pointer' }}
                >
                  <rect x={18} y={h / 2 - 8} width={16} height={16} fill="transparent" />
                  <polygon
                    points={
                      row.collapsed
                        ? `${23},${h / 2 - 4} ${29},${h / 2} ${23},${h / 2 + 4}`
                        : `${21},${h / 2 - 3} ${31},${h / 2 - 3} ${26},${h / 2 + 4}`
                    }
                    fill="var(--color-text-dim)"
                  />
                </g>
                {!renaming && (
                  <text
                    x={X_GROUP}
                    y={h / 2 + 4}
                    fill="var(--color-text)"
                    fontSize={12}
                    fontWeight={600}
                    style={{ cursor: 'text' }}
                  >
                    {fitted.get(row.id)}
                    {/* Only when it was cut. A <title> repeating a name that is
                        already fully drawn is a second copy of it in the text
                        tree — a screen reader says it twice, and a locator
                        looking for the name finds the invisible one first. */}
                    {fitted.get(row.id) !== row.label && <title>{row.label}</title>}
                  </text>
                )}
              </>
            ) : (
              !renaming && (
                <text
                  x={row.groupId ? X_CHILD : X_TOP}
                  y={h / 2 + 4}
                  fill="var(--color-text-soft)"
                  fontSize={11}
                  style={{ cursor: 'text' }}
                >
                  {fitted.get(row.id)}
                  {fitted.get(row.id) !== row.label && <title>{row.label}</title>}
                </text>
              )
            )}
            {renaming && (
              <InlineLabel
                text={row.label}
                x={8}
                y={4}
                width={width - 16}
                height={h - 8}
                onCommit={(text) => {
                  if (text.trim()) updateRow(row.id, { label: text.trim() });
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            )}
          </g>
        );
      })}

      {/* Where it will land. Without this the planner is dragging a row that
          went translucent and guessing at the rest (SRS-EDIT-091). */}
      {drag?.at != null && (
        <g pointerEvents="none" data-pp-rowdrop={drag.at}>
          <line
            x1={4}
            x2={width - 4}
            y1={drag.at < rows.length ? rowOffsets[drag.at] : rowOffsets[rows.length - 1] + rowHeights[rows.length - 1]}
            y2={drag.at < rows.length ? rowOffsets[drag.at] : rowOffsets[rows.length - 1] + rowHeights[rows.length - 1]}
            stroke="var(--color-accent)"
            strokeWidth={2}
          />
          <circle
            cx={6}
            cy={drag.at < rows.length ? rowOffsets[drag.at] : rowOffsets[rows.length - 1] + rowHeights[rows.length - 1]}
            r={3}
            fill="var(--color-accent)"
          />
        </g>
      )}
    </g>
  );
}

/** How far a press travels before it is a reorder and not a click. */
const DRAG_THRESHOLD_PX = 4;

/**
 * Where a dropped row lands, in the index `move_row` speaks (SRS-EDIT-091).
 *
 * Pure, and exported, because this is the whole of the reorder worth being
 * sure about and a jsdom pointer drag proves nothing about it. The operation
 * removes the moving rows first and then inserts at `toIndex`, so the answer
 * is an index into what REMAINS — not into the list the planner can see, and
 * not into the full document either.
 *
 * `boundary` is a slot between visible rows: 0 is above the first, and
 * `visible.length` is past the last. Returns null when the move is a no-op,
 * which is a drop onto the moving row itself or onto one of its own children.
 */
export function dropIndex(
  allRows: Row[],
  visible: Row[],
  movingId: string,
  boundary: number,
): number | null {
  const movingIds = new Set<string>([
    movingId,
    ...allRows.filter((r) => r.groupId === movingId).map((r) => r.id),
  ]);
  const rest = allRows.filter((r) => !movingIds.has(r.id));
  const before = boundary >= 0 && boundary < visible.length ? visible[boundary] : null;
  // Dropping a section onto its own child would ask the operation to insert a
  // run of rows inside the hole those same rows just left.
  if (before && movingIds.has(before.id)) return null;
  if (!before) return rest.length;
  const to = rest.findIndex((r) => r.id === before.id);
  return to < 0 ? rest.length : to;
}

/**
 * Memoised because nothing here changes while a bar is dragged or a title is
 * typed (SRS-LAY-057).
 *
 * React re-renders a child whenever its parent renders, whatever the props
 * are, so narrowing the layout memo stopped the layout being RECOMPUTED but
 * not the whole chart being reconciled. Measured at 6x CPU throttle, ten
 * keystrokes in the title cost 3,855ms before and 3,749ms after that change
 * alone — indistinguishable. The reconciliation was the cost.
 */
export const RowGutter = memo(RowGutterInner);
