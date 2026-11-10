import { describe, expect, test } from 'bun:test';
import { percentAt, rangeRows, secondsAtFraction, timelineWindow } from '../../src/core/labeling/timeline';
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

describe('range rows', () => {
  const window = { start: 100, end: 200 };

  test('places item-relative ranges on the asset axis, one row per group', () => {
    const ranges = [
      { group: 'activity', label: 'talking', start: 10, end: 20 },
      { group: 'position', label: 'sitting', start: 0, end: 50 },
    ];
    const rows = rangeRows(taxonomy.groups, ranges, window, 100);
    expect(rows.map((row) => row.group.id)).toEqual(['position', 'activity']);
    expect(rows[1].bars[0].left).toBe(10);
    expect(rows[1].bars[0].width).toBe(10);
  });

  test('adds a row for the group whose range is being drawn', () => {
    const rows = rangeRows(taxonomy.groups, [], window, 100, 'activity');
    expect(rows.map((row) => row.group.id)).toEqual(['activity']);
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
