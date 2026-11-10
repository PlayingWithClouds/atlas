import type { Group, Range, Span, Taxonomy } from '@atlas/contracts';
import type { Draft } from './draft';
import { pruneInactive, valuesOfGroup } from './draft';

export const MIN_RANGE_SECONDS = 0.1;

export interface RangeTarget {
  group: string;
  label: string;
}

/** A range that has a start and waits for its end; times are relative to the item. */
export interface PendingRange extends RangeTarget {
  start: number;
}

export interface RangeStep {
  pending?: PendingRange;
  range?: Range;
  problem?: string;
}

/** Item-relative seconds of an asset time, kept inside the item. */
export function itemTimeOf(assetSeconds: number, itemStart: number, length: number | undefined): number {
  const relative = Math.max(0, assetSeconds - itemStart);
  if (length === undefined) {
    return relative;
  }
  return Math.min(relative, length);
}

function isSameTarget(pending: PendingRange, target: RangeTarget): boolean {
  return pending.group === target.group && pending.label === target.label;
}

/**
 * One press of the range key: the first starts a range for the target at `time`, the second
 * (same target) ends it. Pressing it for another label restarts there.
 */
export function stepRange(pending: PendingRange | undefined, target: RangeTarget, time: number): RangeStep {
  if (pending === undefined || !isSameTarget(pending, target)) {
    return { pending: { ...target, start: time } };
  }
  const start = Math.min(pending.start, time);
  const end = Math.max(pending.start, time);
  if (end - start < MIN_RANGE_SECONDS) {
    return { pending, problem: "A range needs a few frames: move the playhead first" };
  }
  return { range: { group: target.group, label: target.label, start, end } };
}

function overlaps(first: Range, second: Range): boolean {
  return first.start < second.end && second.start < first.end;
}

/** The ranges that remain once `added` is in; in a single group it replaces whatever it overlaps. */
function rangesWith(group: Group, ranges: Range[], added: Range): Range[] {
  if (group.kind === "multi") {
    return [...ranges, added];
  }
  const kept = ranges.filter((range) => range.group !== group.id || !overlaps(range, added));
  return [...kept, added];
}

/** A label that now holds for part of the item no longer holds for all of it. */
export function addRange(taxonomy: Taxonomy, draft: Draft, range: Range): Draft {
  const group = taxonomy.groups.find((candidate) => candidate.id === range.group);
  if (group === undefined) {
    return draft;
  }
  const wholeItem = valuesOfGroup(draft, group.id).filter((labelId) => labelId !== range.label);
  const values = { ...draft.values };
  if (wholeItem.length === 0) {
    delete values[group.id];
  } else {
    values[group.id] = wholeItem;
  }
  const ranges = rangesWith(group, draft.ranges, range);
  return pruneInactive(taxonomy, { ...draft, values, ranges });
}

export function removeRange(draft: Draft, range: Range): Draft {
  return { ...draft, ranges: draft.ranges.filter((candidate) => candidate !== range) };
}

// --- trimming ----------------------------------------------------------------------------

export const MIN_SPAN_SECONDS = 0.1;

export interface TrimStep {
  span?: Span;
  problem?: string;
}

/** The span the player loops: the person's trim if any, else the item's own span, else the whole asset. */
export function effectiveSpan(itemSpan: Span | undefined, trimmed: Span | undefined, duration: number | undefined): Span | undefined {
  if (trimmed !== undefined) {
    return trimmed;
  }
  if (itemSpan !== undefined) {
    return itemSpan;
  }
  if (duration !== undefined && duration > 0) {
    return { start: 0, end: duration };
  }
  return undefined;
}

function isSameSpan(first: Span, second: Span): boolean {
  return Math.abs(first.start - second.start) < 0.001 && Math.abs(first.end - second.end) < 0.001;
}

function clampToAsset(seconds: number, duration: number | undefined): number {
  const floored = Math.max(0, seconds);
  if (duration === undefined) {
    return floored;
  }
  return Math.min(floored, duration);
}

/** Sets one edge of the trimmed span at the playhead; trimming back to the item's own span clears the trim. */
export function trimEdge(
  edge: "start" | "end",
  playhead: number,
  base: Span | undefined,
  trimmed: Span | undefined,
  duration: number | undefined,
): TrimStep {
  const current = effectiveSpan(base, trimmed, duration);
  if (current === undefined) {
    return { problem: "This asset has no known length to trim" };
  }
  const at = clampToAsset(playhead, duration);
  const next = { ...current, [edge]: at };
  if (next.end - next.start < MIN_SPAN_SECONDS) {
    return { span: trimmed, problem: "The trimmed start must be before its end" };
  }
  if (base !== undefined && isSameSpan(next, base)) {
    return { span: undefined };
  }
  return { span: next };
}
