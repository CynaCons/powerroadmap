import { useMemo, memo } from 'react';
import { useDocumentStore } from '../stores/documentStore';
import { useSelectionStore } from '../stores/selectionStore';
import type { Row } from '../types/document';
import { rowSeparatorOf, rowSeparatorWidthOf, rowSeparatorScopeOf } from '../types/document';

interface Props {
  rows: Row[];
  /** Kept for the caller's shape; separators key off offsets, not heights. */
  rowHeights?: number[];
  rowOffsets: number[];
  width: number;
}

/**
 * Row separators (SRS-LAY-061).
 *
 * A rule under every row turns a long plan into ruled paper and competes with
 * the bars for attention, so the default stays what it was: one hairline above
 * each group header, the gutter's indent and weight carrying the rest (owner
 * report 2026-10-23).
 *
 * It is a default now rather than the only option. The owner asked on
 * 2026-11-04 to configure it — a line whose width is theirs to choose, or a
 * dashed or dotted one, and between every row if they want it. `solid` at
 * width 1 over groups draws exactly what this component drew before, so a plan
 * written without the setting is unchanged.
 */
function RowsInner({ rows, rowHeights, rowOffsets, width }: Props) {
  const allRows = useDocumentStore((s) => s.doc.rows);
  const hasChildren = new Set(allRows.filter((r) => r.groupId).map((r) => r.groupId as string));
  const doc = useDocumentStore((s) => s.doc);
  const items = useSelectionStore((s) => s.items);

  // The rule the planner asked for. Read through the helpers so a plan written
  // before the setting existed draws what it always drew.
  const separator = rowSeparatorOf(doc.style);
  const sepWidth = rowSeparatorWidthOf(doc.style);
  const scope = rowSeparatorScopeOf(doc.style);
  /* The pattern scales with the width, or a 4px dashed rule is a solid one
     with a rumour of a gap. A dot is drawn as a zero-length dash so a round
     cap can make it round. */
  const dash =
    separator === 'dashed'
      ? `${sepWidth * 3} ${sepWidth * 2}`
      : separator === 'dotted'
        ? `0 ${sepWidth * 2.5}`
        : undefined;
  /*
   * A rule nobody asked for stays a whisper; a rule somebody chose is legible.
   *
   * The default ink measured 1.23:1 against the sheet, which is correct for the
   * one hairline above a section heading and useless for a planner who opened
   * Settings and picked "Dashed, 2px, between every row" — they would have got
   * 38 lines they cannot see and reported the feature as broken.
   */
  const configured =
    doc.style?.rowSeparator !== undefined ||
    doc.style?.rowSeparatorWidth !== undefined ||
    doc.style?.rowSeparatorScope !== undefined;
  const ink = configured ? 'var(--color-row-rule)' : 'var(--color-border-soft)';

  /**
   * Which rows the band belongs to.
   *
   * The owner asked for the whole row to light up when he picks something on
   * it, so a bar or a milestone bands its own row rather than only a row that
   * was clicked in the list.
   */
  const bandRows = useMemo(() => {
    const ids = new Set<string>();
    for (const it of items) {
      if (it.kind === 'row') ids.add(it.id);
      else if (it.kind === 'task') {
        const t = doc.tasks.find((x) => x.id === it.id);
        if (t) ids.add(t.rowId);
      } else if (it.kind === 'milestone') {
        const m = doc.milestones.find((x) => x.id === it.id);
        if (m) ids.add(m.rowId);
      }
    }
    return ids;
  }, [items, doc]);

  return (
    <g>
      {/*
        The selected row's band, drawn across the whole sheet (SRS-EDIT-024).

        It lived in the gutter alone, so at any useful zoom the tint stopped at
        the row labels and the eye had to carry a bar back across an untinted
        plot to know whose row it was. This layer is inside `chart-body-clip`,
        which spans the gutter and the plot together, and it draws under the
        bars because the plot group comes after it.
      */}
      {rows.map((row, i) =>
        bandRows.has(row.id) ? (
          <g key={`band-${row.id}`} data-pp-rowband="1" pointerEvents="none">
            <rect
              x={0}
              y={rowOffsets[i]}
              width={width}
              height={rowHeights?.[i] ?? 0}
              fill="var(--color-accent)"
              opacity={0.07}
            />
            <rect
              x={0}
              y={rowOffsets[i]}
              width={3}
              height={rowHeights?.[i] ?? 0}
              fill="var(--color-accent)"
            />
          </g>
        ) : null,
      )}

      {separator !== 'none' &&
        rows.map((row, i) => {
          // A rule sits ABOVE a row, so the first one is never drawn: the axis
          // baseline already closes the top of the sheet off.
          if (i === 0) return null;
          // A group header opens a band. Over `all`, every boundary gets one.
          if (scope === 'groups' && !hasChildren.has(row.id)) return null;
          return (
            <line
              key={row.id}
              data-pp-rowsep={separator}
              x1={0}
              y1={rowOffsets[i]}
              x2={width}
              y2={rowOffsets[i]}
              stroke={ink}
              strokeWidth={sepWidth}
              strokeDasharray={dash}
              /* A dot is a round cap on a zero-length dash. Without this a
                 "dotted" 1px rule is indistinguishable from a dashed one. */
              strokeLinecap={separator === 'dotted' ? 'round' : undefined}
            />
          );
        })}
    </g>
  );
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
export const Rows = memo(RowsInner);
