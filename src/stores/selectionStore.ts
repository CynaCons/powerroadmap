import { useCallback } from 'react';
import { create } from 'zustand';

export type SelectableKind = 'task' | 'milestone' | 'bracket' | 'dependency' | 'marker' | 'row';

export interface Selectable {
  kind: SelectableKind;
  id: string;
  /**
   * Set on the row that was selected only because something on it was
   * (SRS-EDIT-088). Clicking a bar lights its row in the gutter too — one
   * selection shown in two places — and this is what says which of the two
   * the planner actually pointed at. Guessing it from `kind === 'row'` is
   * what three separate call sites used to do, each slightly differently.
   */
  companionFor?: string;
}

interface SelectionState {
  items: Selectable[];
  setSelection: (items: Selectable[]) => void;
  add: (item: Selectable) => void;
  /** Add it if it is not in, take it out if it is (SRS-EDIT-088). */
  toggle: (item: Selectable) => void;
  remove: (id: string) => void;
  clear: () => void;
  isSelected: (id: string) => boolean;
}

/**
 * What the planner actually picked, as opposed to what is highlighted.
 *
 * Clicking a bar selects the bar AND the row it sits on, so the gutter lights
 * up with it — one selection shown in two places. Every question of the form
 * "how many things are selected" or "what is THE selected thing" means the
 * bar, not both; the row is a companion.
 *
 * Three files worked that out separately and the ones that did not are where
 * the bugs were: F2 asked for `items.length === 1` and a clicked bar gives it
 * two, so the rename advertised in the shortcuts sheet did nothing; the
 * Selection panel counted the companion and printed one more than the footer;
 * the right-click Delete took one of four. One derivation now, used
 * everywhere, so there is no third behaviour to find later.
 *
 * A row picked on its own carries no `companionFor` and is a subject like
 * anything else; only a row that came along with something else is dropped.
 */
export function selectionSubjects(items: Selectable[]): Selectable[] {
  return items.filter((i) => i.companionFor === undefined);
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  items: [],
  setSelection: (items) => set({ items }),
  add: (item) => {
    if (get().isSelected(item.id)) return;
    set({ items: [...get().items, item] });
  },
  /**
   * Ctrl-click could add a bar to a selection and never take one out: the
   * handler read `if (!isSelected(id)) add(...)`, so a second ctrl-click on
   * the same bar was a no-op. Taking a bar out takes its companion row with
   * it, unless another selected bar still sits on that row.
   */
  toggle: (item) => {
    const items = get().items;
    if (!items.some((i) => i.id === item.id)) {
      set({ items: [...items, item] });
      return;
    }
    // Taking a bar out takes the row it brought with it, unless another bar
    // that is still selected brought the same one.
    const left = items.filter((i) => i.id !== item.id);
    set({
      items: left.filter((i) => i.companionFor === undefined || left.some((j) => j.id === i.companionFor)),
    });
  },
  remove: (id) => set({ items: get().items.filter((i) => i.id !== id) }),
  clear: () => set({ items: [] }),
  isSelected: (id) => get().items.some((i) => i.id === id),
}));

/**
 * Ask whether something is selected, from a component that must repaint when
 * the answer changes (SRS-EDIT-023).
 *
 * `useSelectionStore((s) => s.isSelected)` reads correctly and subscribes to
 * nothing: the selector returns the function `create()` built once, its
 * reference never changes, and Zustand's equality check therefore passes on
 * every update. Five chart renderers did exactly that, so the selection chrome
 * was computed from live state inside a component React had no reason to
 * re-render — it painted only when something unrelated forced a pass. The
 * status bar and the command bar read `items` and updated, which is why the
 * footer answered a click the chart ignored.
 *
 * Subscribing to `items` is the whole fix. The returned predicate is memoised
 * on that array so it stays stable between selection changes.
 */
export function useIsSelected(): (id: string) => boolean {
  const items = useSelectionStore((s) => s.items);
  return useCallback((id: string) => items.some((i) => i.id === id), [items]);
}
