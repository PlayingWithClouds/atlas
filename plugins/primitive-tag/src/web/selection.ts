/** Pure selection helpers for grid labelers; positions index into the currently visible items. */

export function toggleId(selectedIds: Set<string>, itemId: string): Set<string> {
  const next = new Set(selectedIds);
  if (next.has(itemId)) {
    next.delete(itemId);
    return next;
  }
  next.add(itemId);
  return next;
}

/** Ids from `anchorPosition` to `position`, both inclusive, in either direction. */
export function selectRange(orderedIds: string[], anchorPosition: number, position: number): Set<string> {
  const first = Math.min(anchorPosition, position);
  const last = Math.max(anchorPosition, position);
  return new Set(orderedIds.slice(first, last + 1));
}

export interface ClickModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export interface SelectionState {
  selectedIds: Set<string>;
  anchorPosition: number | null;
}

export type ClickOutcome = { kind: "open" } | { kind: "select"; state: SelectionState };

/**
 * Shift extends from the anchor, ctrl/meta toggles, and a plain click toggles while a
 * selection exists or opens the item when nothing is selected.
 */
export function resolveClick(
  orderedIds: string[],
  position: number,
  state: SelectionState,
  modifiers: ClickModifiers,
): ClickOutcome {
  const itemId = orderedIds[position];
  if (modifiers.shiftKey) {
    return { kind: "select", state: extendSelection(orderedIds, position, state) };
  }
  const hasSelection = state.selectedIds.size > 0;
  if (modifiers.ctrlKey || modifiers.metaKey || hasSelection) {
    return { kind: "select", state: { selectedIds: toggleId(state.selectedIds, itemId), anchorPosition: position } };
  }
  return { kind: "open" };
}

function extendSelection(orderedIds: string[], position: number, state: SelectionState): SelectionState {
  if (state.anchorPosition === null) {
    return { selectedIds: new Set([orderedIds[position]]), anchorPosition: position };
  }
  return { selectedIds: selectRange(orderedIds, state.anchorPosition, position), anchorPosition: state.anchorPosition };
}
