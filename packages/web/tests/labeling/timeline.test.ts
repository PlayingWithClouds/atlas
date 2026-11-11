import { describe, expect, test } from 'bun:test';
import { MIN_RANGE_SECONDS } from '../../src/core/labeling/ranges';
import {
  MIN_VIEW_SECONDS,
  draggedRange,
  labelTracks,
  pageTo,
  panWindow,
  percentAt,
  rangeBetween,
  secondsAtFraction,
  snapTime,
  tickStep,
  ticksOf,
  timelineWindow,
  zoomWindow,
  rangesFromHere,
} from '../../src/core/labeling/timeline';
import { formatClock } from '../../src/core/shared/time';
import { taxonomy } from './fixtures';

describe('timeline window', () => {
  test('pads the item span and stays inside the asset', () => {
    expect(timelineWindow({ start: 100, end: 120 }, undefined, 300)).toEqual({ start: 95, end: 125 });
    expect(timelineWindow({ start: 0, end: 10 }, undefined, 11)).toEqual({ start: 0, end: 11 });
  });

  test('widens to hold a trim that reaches outside the item', () => {
    const window = timelineWindow({ start: 100, end: 120 }, { start: 90, end: 130 }, 300);
    expect(window.start).toBeLessThan(90);
    expect(window.end).toBeGreaterThan(130);
  });

  test('maps seconds to percent and back', () => {
    const window = { start: 100, end: 200 };
    expect(percentAt(window, 150)).toBe(50);
    expect(percentAt(window, 50)).toBe(0);
    expect(percentAt(window, 500)).toBe(100);
    expect(secondsAtFraction(window, 0.25)).toBe(125);
    expect(secondsAtFraction(window, 3)).toBe(200);
  });
});

describe('zoom and pan', () => {
  const bounds = { start: 0, end: 600 };

  test('zooms around the anchor and keeps it in place', () => {
    const zoomed = zoomWindow({ start: 100, end: 200 }, bounds, 150, 0.5);
    expect(zoomed).toEqual({ start: 125, end: 175 });
    const off = zoomWindow({ start: 100, end: 200 }, bounds, 100, 0.5);
    expect(off).toEqual({ start: 100, end: 150 });
  });

  test('never zooms past the asset or below a second', () => {
    expect(zoomWindow({ start: 100, end: 200 }, bounds, 150, 100)).toEqual(bounds);
    const tight = zoomWindow({ start: 100, end: 102 }, bounds, 101, 0.01);
    expect(tight.end - tight.start).toBe(MIN_VIEW_SECONDS);
  });

  test('pans inside the asset', () => {
    expect(panWindow({ start: 100, end: 200 }, bounds, 50)).toEqual({ start: 150, end: 250 });
    expect(panWindow({ start: 100, end: 200 }, bounds, -500)).toEqual({ start: 0, end: 100 });
    expect(panWindow({ start: 100, end: 200 }, bounds, 900)).toEqual({ start: 500, end: 600 });
  });

  test('pages to keep a running playhead in view', () => {
    expect(pageTo({ start: 0, end: 100 }, bounds, 120)).toEqual({ start: 110, end: 210 });
  });
});

describe('ruler', () => {
  test('picks round tick steps that leave room for their labels', () => {
    expect(tickStep({ start: 0, end: 60 }, 600)).toBe(10);
    expect(tickStep({ start: 0, end: 3 }, 600)).toBe(0.5);
    expect(ticksOf({ start: 9.5, end: 31 }, 10)).toEqual([10, 20, 30]);
  });
});

describe('label tracks', () => {
  const position = taxonomy.groups[0];
  const activity = taxonomy.groups[2];

  test('one track per label that is on, in ranges, suggested or armed', () => {
    const tracks = labelTracks({
      groups: taxonomy.groups,
      values: { position: ['sitting'] },
      ranges: [{ group: 'activity', label: 'talking', start: 1, end: 4 }],
      suggested: [
        { group: 'activity', label: 'dancing', start: 5, end: 9, score: 0.8 },
        { group: 'extras', label: 'hat', start: 0, end: 2, score: 0.1 },
      ],
      armed: { group: 'extras', label: 'glasses' },
    });
    expect(tracks.map((track) => `${track.group.id}.${track.label.id}`)).toEqual([
      'position.sitting',
      'activity.talking',
      'activity.dancing',
      'extras.glasses',
    ]);
    expect(tracks[0].whole).toBe(true);
    expect(tracks[1].ranges).toHaveLength(1);
    expect(tracks[2].ghosts).toHaveLength(1);
    expect(tracks[3].armed).toBe(true);
  });

  test('hides suggestions a range already covers and those of inactive groups', () => {
    const tracks = labelTracks({
      groups: taxonomy.groups,
      values: {},
      ranges: [{ group: 'activity', label: 'talking', start: 0, end: 4 }],
      suggested: [
        { group: 'activity', label: 'talking', start: 2, end: 6, score: 0.9 },
        { group: 'pose', label: 'arms-up', start: 0, end: 2, score: 0.9 },
      ],
    });
    expect(tracks).toHaveLength(1);
    expect(tracks[0].ghosts).toEqual([]);
    expect(position.id).toBe('position');
    expect(activity.id).toBe('activity');
  });

  test('refinement tracks follow their parent; exact matches show inside the parent bar', () => {
    const parent = { group: 'position', label: 'standing', start: 0, end: 4 };
    const tracks = labelTracks({
      groups: taxonomy.groups,
      values: { activity: ['talking'] },
      ranges: [parent, { group: 'pose', label: 'arms-up', start: 0, end: 4 }, { group: 'pose', label: 'arms-down', start: 1, end: 2 }],
      suggested: [],
    });
    expect(tracks.map((track) => track.label.id)).toEqual(['standing', 'arms-down', 'talking']);
    expect(tracks[0].rangeNotes).toEqual(['Arms up']);
    expect(tracks[1].refines).toEqual({ group: 'position', label: 'standing' });
  });

  test('a whole-item refinement is noted on the parent', () => {
    const tracks = labelTracks({ groups: taxonomy.groups, values: { position: ['standing'], pose: ['arms-up'] }, ranges: [], suggested: [] });
    expect(tracks.map((track) => track.label.id)).toEqual(['standing']);
    expect(tracks[0].wholeNote).toBe('Arms up');
  });

  test('a range of the condition label opens the conditional group', () => {
    const tracks = labelTracks({
      groups: taxonomy.groups,
      values: {},
      ranges: [{ group: 'position', label: 'standing', start: 0, end: 4 }],
      suggested: [{ group: 'pose', label: 'arms-up', start: 0, end: 2, score: 0.9 }],
    });
    expect(tracks.map((track) => track.label.id)).toEqual(['standing', 'arms-up']);
  });
});

describe('editing ranges', () => {
  const range = { group: 'activity', label: 'talking', start: 2, end: 5 };

  test('drags edges and bars inside the item', () => {
    expect(draggedRange(range, 'start', -1, 10)).toEqual({ ...range, start: 1 });
    expect(draggedRange(range, 'start', -9, 10)).toEqual({ ...range, start: 0 });
    expect(draggedRange(range, 'start', 9, 10).start).toBeCloseTo(5 - MIN_RANGE_SECONDS);
    expect(draggedRange(range, 'end', 9, 10)).toEqual({ ...range, end: 10 });
    expect(draggedRange(range, 'move', 9, 10)).toEqual({ ...range, start: 7, end: 10 });
    expect(draggedRange(range, 'move', -9, undefined)).toEqual({ ...range, start: 0, end: 3 });
  });

  test('builds a range from a drag in either direction', () => {
    const target = { group: 'activity', label: 'talking' };
    expect(rangeBetween(target, 6, 2, 10)).toEqual({ ...target, start: 2, end: 6 });
    expect(rangeBetween(target, -1, 12, 10)).toEqual({ ...target, start: 0, end: 10 });
    expect(rangeBetween(target, 3, 3.01, 10)).toBeUndefined();
  });

  test('snaps to the playhead nearby, else to frames', () => {
    expect(snapTime(10.02, 10, 0.05, 25)).toBe(10);
    expect(snapTime(12.03, 10, 0.05, 25)).toBe(12.04);
    expect(snapTime(12.03, 10, 0.05, 0)).toBe(12.03);
  });
});

describe('formatClock', () => {
  test('formats minutes, hours and fractions', () => {
    expect(formatClock(75)).toBe('1:15');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(5.25, 1)).toBe('0:05.2');
    expect(formatClock(-3)).toBe('0:00');
  });
});

describe('rangesFromHere', () => {
  const ghost = (label: string, start: number, end: number, score = 0.8) => ({ group: 'activity', label, start, end, score });

  test('takes every suggestion under the playhead, from here to its end', () => {
    const taken = rangesFromHere([ghost('talking', 2, 10), ghost('dancing', 4, 6), ghost('talking', 12, 14)], [], 5, 0.2);
    expect(taken).toEqual([
      { group: 'activity', label: 'talking', start: 5, end: 10 },
      { group: 'activity', label: 'dancing', start: 5, end: 6 },
    ]);
  });

  test('skips faint suggestions, labels already on here, and leftovers too short', () => {
    expect(rangesFromHere([ghost('talking', 2, 10, 0.1)], [], 5, 0.2)).toEqual([]);
    expect(rangesFromHere([ghost('talking', 2, 10)], [{ group: 'activity', label: 'talking', start: 4, end: 6 }], 5, 0.2)).toEqual([]);
    expect(rangesFromHere([ghost('talking', 2, 5.1)], [], 5, 0.2)).toEqual([]);
  });
});
