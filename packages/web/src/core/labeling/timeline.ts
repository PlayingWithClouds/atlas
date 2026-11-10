import type { Group, Range, Span } from '@atlas/contracts';

export interface TimelineWindow {
  /** Asset seconds at the left and right edge. */
  start: number;
  end: number;
}

export interface RangeBar {
  range: Range;
  /** Percent of the window width. */
  left: number;
  width: number;
}

export interface RangeRow {
  group: Group;
  bars: RangeBar[];
}

const PADDING_FRACTION = 0.25;
const MIN_PADDING_SECONDS = 2;

/** The item's span with some air around it, widened to hold the trim and kept inside the asset. */
export function timelineWindow(itemSpan: Span, trimmed: Span | undefined, duration: number | undefined): TimelineWindow {
  let start = itemSpan.start;
  let end = itemSpan.end;
  if (trimmed !== undefined) {
    start = Math.min(start, trimmed.start);
    end = Math.max(end, trimmed.end);
  }
  const padding = Math.max(MIN_PADDING_SECONDS, (end - start) * PADDING_FRACTION);
  start = Math.max(0, start - padding);
  end = end + padding;
  if (duration !== undefined) {
    end = Math.min(duration, end);
  }
  return { start, end };
}

export function percentAt(window: TimelineWindow, seconds: number): number {
  const fraction = (seconds - window.start) / (window.end - window.start);
  return Math.min(100, Math.max(0, fraction * 100));
}

export function secondsAtFraction(window: TimelineWindow, fraction: number): number {
  const clamped = Math.min(1, Math.max(0, fraction));
  return window.start + clamped * (window.end - window.start);
}

function barOf(window: TimelineWindow, itemStart: number, range: Range): RangeBar {
  const left = percentAt(window, itemStart + range.start);
  const right = percentAt(window, itemStart + range.end);
  return { range, left, width: right - left };
}

/** One row per group that has ranges (or `alsoGroupId`, whose range is being drawn), in taxonomy order; range times are item-relative. */
export function rangeRows(
  groups: Group[],
  ranges: Range[],
  window: TimelineWindow,
  itemStart: number,
  alsoGroupId?: string,
): RangeRow[] {
  const rows: RangeRow[] = [];
  for (const group of groups) {
    const ofGroup = ranges.filter((range) => range.group === group.id);
    if (ofGroup.length > 0 || group.id === alsoGroupId) {
      rows.push({ group, bars: ofGroup.map((range) => barOf(window, itemStart, range)) });
    }
  }
  return rows;
}
