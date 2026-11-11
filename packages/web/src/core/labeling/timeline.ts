import { isGroupActive } from '@atlas/contracts';
import type { Group, Label, Range, Span } from '@atlas/contracts';
import { MIN_RANGE_SECONDS } from './ranges';
import type { RangeTarget } from './ranges';

export interface TimelineWindow {
  /** Asset seconds at the left and right edge. */
  start: number;
  end: number;
}

const PADDING_FRACTION = 0.25;
const MIN_PADDING_SECONDS = 2;
/** The narrowest the timeline zooms in to. */
export const MIN_VIEW_SECONDS = 1;

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

// --- zoom and pan --------------------------------------------------------------------------

/** Moves a window of unchanged width so it lies inside `bounds` (or fills them if wider). */
function shiftInside(start: number, width: number, bounds: TimelineWindow): TimelineWindow {
  const boundsWidth = bounds.end - bounds.start;
  if (width >= boundsWidth) {
    return { ...bounds };
  }
  const clampedStart = Math.min(Math.max(start, bounds.start), bounds.end - width);
  return { start: clampedStart, end: clampedStart + width };
}

/** Zooms by `factor` (< 1 = in) keeping `anchor` at the same place on screen. */
export function zoomWindow(view: TimelineWindow, bounds: TimelineWindow, anchor: number, factor: number): TimelineWindow {
  const width = view.end - view.start;
  const nextWidth = Math.min(bounds.end - bounds.start, Math.max(MIN_VIEW_SECONDS, width * factor));
  const anchorFraction = (anchor - view.start) / width;
  return shiftInside(anchor - anchorFraction * nextWidth, nextWidth, bounds);
}

export function panWindow(view: TimelineWindow, bounds: TimelineWindow, seconds: number): TimelineWindow {
  return shiftInside(view.start + seconds, view.end - view.start, bounds);
}

/** A window of the same width that shows `seconds` near its left edge (following playback). */
export function pageTo(view: TimelineWindow, bounds: TimelineWindow, seconds: number): TimelineWindow {
  const width = view.end - view.start;
  return shiftInside(seconds - width * 0.1, width, bounds);
}

// --- ruler ---------------------------------------------------------------------------------

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** The smallest round step that keeps ticks at least `minSpacing` pixels apart. */
export function tickStep(window: TimelineWindow, widthPixels: number, minSpacing = 72): number {
  const secondsPerPixel = (window.end - window.start) / Math.max(1, widthPixels);
  const wanted = secondsPerPixel * minSpacing;
  const step = TICK_STEPS.find((candidate) => candidate >= wanted);
  if (step === undefined) {
    return TICK_STEPS[TICK_STEPS.length - 1];
  }
  return step;
}

export function ticksOf(window: TimelineWindow, step: number): number[] {
  const ticks: number[] = [];
  const first = Math.ceil(window.start / step - 1e-9) * step;
  for (let seconds = first; seconds <= window.end + 1e-9; seconds += step) {
    ticks.push(Math.round(seconds * 1000) / 1000);
  }
  return ticks;
}

// --- tracks --------------------------------------------------------------------------------

export interface SuggestedRange extends Range {
  score: number;
}

/** Suggested ranges below this score are not drawn. */
export const GHOST_THRESHOLD = 0.3;

/** One row of the timeline: a label that is on (for the whole item or in ranges), suggested, or armed. */
export interface LabelTrack {
  group: Group;
  label: Label;
  /** The label holds for the whole item. */
  whole: boolean;
  /** Item-relative. */
  ranges: Range[];
  /** Model ranges not yet taken over, item-relative. */
  ghosts: SuggestedRange[];
  /** The label R or a drag in the track would use. */
  armed: boolean;
}

export interface TrackInputs {
  groups: Group[];
  values: Record<string, string[]>;
  ranges: Range[];
  suggested: SuggestedRange[];
  armed?: RangeTarget;
}

function overlaps(first: Range, second: Range): boolean {
  return first.start < second.end && second.start < first.end;
}

function ghostsOf(inputs: TrackInputs, group: Group, label: Label, ranges: Range[]): SuggestedRange[] {
  if (!isGroupActive(group, inputs.values, inputs.ranges)) {
    return [];
  }
  return inputs.suggested.filter(
    (ghost) =>
      ghost.group === group.id &&
      ghost.label === label.id &&
      ghost.score >= GHOST_THRESHOLD &&
      !ranges.some((range) => overlaps(range, ghost)),
  );
}

function isArmed(inputs: TrackInputs, group: Group, label: Label): boolean {
  return inputs.armed !== undefined && inputs.armed.group === group.id && inputs.armed.label === label.id;
}

function trackOf(inputs: TrackInputs, group: Group, label: Label): LabelTrack | undefined {
  const values = inputs.values[group.id];
  const whole = values !== undefined && values.includes(label.id);
  const ranges = inputs.ranges.filter((range) => range.group === group.id && range.label === label.id);
  const ghosts = ghostsOf(inputs, group, label, ranges);
  const armed = isArmed(inputs, group, label);
  if (!whole && ranges.length === 0 && ghosts.length === 0 && !armed) {
    return undefined;
  }
  return { group, label, whole, ranges, ghosts, armed };
}

/** Tracks in taxonomy order: everything that is on, suggested as a range, or armed. */
export function labelTracks(inputs: TrackInputs): LabelTrack[] {
  const tracks: LabelTrack[] = [];
  for (const group of inputs.groups) {
    for (const label of group.labels) {
      const track = trackOf(inputs, group, label);
      if (track !== undefined) {
        tracks.push(track);
      }
    }
  }
  return tracks;
}

// --- editing ranges ------------------------------------------------------------------------

export type RangeDragMode = 'start' | 'end' | 'move';

function upperBound(length: number | undefined): number {
  if (length === undefined) {
    return Infinity;
  }
  return length;
}

/** A range after dragging one edge or the whole bar by `delta` seconds, kept inside the item. */
export function draggedRange(range: Range, mode: RangeDragMode, delta: number, length: number | undefined): Range {
  const limit = upperBound(length);
  if (mode === 'start') {
    const start = Math.min(Math.max(0, range.start + delta), range.end - MIN_RANGE_SECONDS);
    return { ...range, start };
  }
  if (mode === 'end') {
    const end = Math.max(Math.min(limit, range.end + delta), range.start + MIN_RANGE_SECONDS);
    return { ...range, end };
  }
  const shift = Math.min(Math.max(delta, -range.start), limit - range.end);
  return { ...range, start: range.start + shift, end: range.end + shift };
}

/** The range between two item-relative times in either order, or undefined when too short. */
export function rangeBetween(target: RangeTarget, first: number, second: number, length: number | undefined): Range | undefined {
  const start = Math.max(0, Math.min(first, second));
  const end = Math.min(upperBound(length), Math.max(first, second));
  if (end - start < MIN_RANGE_SECONDS) {
    return undefined;
  }
  return { group: target.group, label: target.label, start, end };
}

/**
 * Pulls a time onto the playhead when within `tolerance` seconds of it, else onto the nearest
 * frame boundary, so dragged edges land exactly where frame stepping left the playhead.
 */
export function snapTime(seconds: number, playhead: number, tolerance: number, frameRate: number): number {
  if (Math.abs(seconds - playhead) <= tolerance) {
    return playhead;
  }
  if (frameRate <= 0) {
    return seconds;
  }
  return Math.round(seconds * frameRate) / frameRate;
}
