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

// --- open ranges (several labels started at the playhead, closed together) ----------------

export function findPending(open: PendingRange[], target: RangeTarget): PendingRange | undefined {
  return open.find((pending) => isSameTarget(pending, target));
}

/** Opens a range for the target at `time`, or drops it when it is already open. */
export function togglePending(open: PendingRange[], target: RangeTarget, time: number): PendingRange[] {
  if (findPending(open, target) !== undefined) {
    return open.filter((pending) => !isSameTarget(pending, target));
  }
  return [...open, { group: target.group, label: target.label, start: time }];
}

/** Every open range starts over at `time`. */
export function restartPending(open: PendingRange[], time: number): PendingRange[] {
  return open.map((pending) => ({ ...pending, start: time }));
}

export interface ClosedRanges {
  ranges: Range[];
  /** Ranges too short to close; they stay open. */
  open: PendingRange[];
  problem?: string;
}

/** Closes every open range at `time` (either side of its start). */
export function closePending(open: PendingRange[], time: number): ClosedRanges {
  const ranges: Range[] = [];
  const tooShort: PendingRange[] = [];
  for (const pending of open) {
    const start = Math.min(pending.start, time);
    const end = Math.max(pending.start, time);
    if (end - start < MIN_RANGE_SECONDS) {
      tooShort.push(pending);
      continue;
    }
    ranges.push({ group: pending.group, label: pending.label, start, end });
  }
  if (tooShort.length > 0) {
    return { ranges, open: tooShort, problem: "A range needs a few frames: move the playhead first" };
  }
  return { ranges, open: [] };
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

function findGroup(taxonomy: Taxonomy, groupId: string): Group | undefined {
  return taxonomy.groups.find((candidate) => candidate.id === groupId);
}

/**
 * A label that now holds for part of the item no longer holds for all of it. A refinement's range
 * (e.g. facefuck under blowjob) also puts its parent label on there.
 */
export function addRange(taxonomy: Taxonomy, draft: Draft, range: Range): Draft {
  const group = findGroup(taxonomy, range.group);
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
  return pruneInactive(taxonomy, coverParent(taxonomy, { ...draft, values, ranges }, group, range));
}

export function removeRange(draft: Draft, range: Range): Draft {
  return { ...draft, ranges: draft.ranges.filter((candidate) => candidate !== range) };
}

// --- refinements ---------------------------------------------------------------------------

function isLabel(range: Range, target: RangeTarget): boolean {
  return range.group === target.group && range.label === target.label;
}

/** Grows (or adds) the parent label's range so it covers a refinement range, unless the parent holds for the whole item. */
function coverParent(taxonomy: Taxonomy, draft: Draft, group: Group, range: Range): Draft {
  const condition = group.when;
  if (condition === undefined || valuesOfGroup(draft, condition.group).includes(condition.label)) {
    return draft;
  }
  const parentGroup = findGroup(taxonomy, condition.group);
  if (parentGroup === undefined) {
    return draft;
  }
  const touching = draft.ranges.filter((candidate) => isLabel(candidate, condition) && candidate.start <= range.end && range.start <= candidate.end);
  if (touching.some((candidate) => candidate.start <= range.start && candidate.end >= range.end)) {
    return draft;
  }
  const merged = {
    group: condition.group,
    label: condition.label,
    start: Math.min(range.start, ...touching.map((candidate) => candidate.start)),
    end: Math.max(range.end, ...touching.map((candidate) => candidate.end)),
  };
  const others = draft.ranges.filter((candidate) => !touching.includes(candidate));
  return { ...draft, ranges: rangesWith(parentGroup, others, merged) };
}

function refinementIdsOf(taxonomy: Taxonomy, target: RangeTarget): string[] {
  return taxonomy.groups
    .filter((group) => group.when !== undefined && group.when.group === target.group && group.when.label === target.label)
    .map((group) => group.id);
}

function followedRange(refinement: Range, previous: Range, next: Range): Range | undefined {
  if (isSameSpan(refinement, previous)) {
    return { ...refinement, start: next.start, end: next.end };
  }
  const moved = Math.abs(next.end - next.start - (previous.end - previous.start)) < 1e-6;
  if (moved) {
    const shift = next.start - previous.start;
    return { ...refinement, start: refinement.start + shift, end: refinement.end + shift };
  }
  const start = Math.max(refinement.start, next.start);
  const end = Math.min(refinement.end, next.end);
  if (end - start < MIN_RANGE_SECONDS) {
    return undefined;
  }
  return { ...refinement, start, end };
}

/** Refinement ranges inside a parent range follow its edit: shifted when it moved, clipped when resized. */
export function carryRefinements(taxonomy: Taxonomy, draft: Draft, previous: Range, next: Range): Draft {
  const refinementIds = refinementIdsOf(taxonomy, previous);
  if (refinementIds.length === 0) {
    return draft;
  }
  const ranges = draft.ranges.flatMap((range) => {
    if (!refinementIds.includes(range.group) || !overlaps(range, previous)) {
      return [range];
    }
    const followed = followedRange(range, previous, next);
    if (followed === undefined) {
      return [];
    }
    return [followed];
  });
  return { ...draft, ranges };
}

function isCoveredByParent(taxonomy: Taxonomy, draft: Draft, range: Range): boolean {
  const condition = findGroup(taxonomy, range.group)?.when;
  if (condition === undefined || valuesOfGroup(draft, condition.group).includes(condition.label)) {
    return true;
  }
  return draft.ranges.some((candidate) => isLabel(candidate, condition) && overlaps(candidate, range));
}

/** Deletes a range; refinement ranges that only lived inside it go with it. */
export function deleteRange(taxonomy: Taxonomy, draft: Draft, range: Range): Draft {
  const removed = removeRange(draft, range);
  const ranges = removed.ranges.filter((candidate) => isCoveredByParent(taxonomy, removed, candidate));
  return pruneInactive(taxonomy, { ...removed, ranges });
}

/** Swaps a range for its edited copy, taking its refinements along. */
export function replaceRange(taxonomy: Taxonomy, draft: Draft, previous: Range, next: Range): Draft {
  const replaced = addRange(taxonomy, removeRange(draft, previous), next);
  return carryRefinements(taxonomy, replaced, previous, next);
}

/** Sets (or, when already set, clears) a refinement label for exactly the span of a parent range. */
export function refineRange(taxonomy: Taxonomy, draft: Draft, parent: Range, target: RangeTarget): Draft {
  const existing = draft.ranges.find((range) => isLabel(range, target) && isSameSpan(range, parent));
  if (existing !== undefined) {
    return removeRange(draft, existing);
  }
  return addRange(taxonomy, draft, { ...target, start: parent.start, end: parent.end });
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

/** Equal to the millisecond. */
export function isSameSpan(first: Span, second: Span): boolean {
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
