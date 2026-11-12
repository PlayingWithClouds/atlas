import { describe, expect, test } from 'bun:test';
import { emptyDraft, toggleLabel } from '../../src/core/labeling/draft';
import { addRange, eraseRange } from '../../src/core/labeling/ranges';
import { nearestAnchor, snapToAnchors } from '../../src/core/labeling/timeline';
import { taxonomy } from './fixtures';

const talking = { group: 'activity', label: 'talking' };
const standing = { group: 'position', label: 'standing' };
const armsUp = { group: 'pose', label: 'arms-up' };
const group = (id: string) => taxonomy.groups.find((candidate) => candidate.id === id)!;

describe('erasing part of a label', () => {
  test('the middle of a range splits it in two', () => {
    const draft = addRange(taxonomy, emptyDraft(), { ...talking, start: 2, end: 10 });
    const erased = eraseRange(taxonomy, draft, talking, 4, 6, 20);
    expect(erased.ranges).toEqual([
      { ...talking, start: 2, end: 4 },
      { ...talking, start: 6, end: 10 },
    ]);
  });

  test('covering a whole range removes it; other labels stay', () => {
    let draft = addRange(taxonomy, emptyDraft(), { ...talking, start: 2, end: 4 });
    draft = addRange(taxonomy, draft, { group: 'activity', label: 'dancing', start: 2, end: 4 });
    const erased = eraseRange(taxonomy, draft, talking, 1, 5, 20);
    expect(erased.ranges).toEqual([{ group: 'activity', label: 'dancing', start: 2, end: 4 }]);
  });

  test('a whole-item label keeps the parts before and after', () => {
    const draft = toggleLabel(taxonomy, emptyDraft(), group('activity'), 'talking');
    const erased = eraseRange(taxonomy, draft, talking, 5, 8, 20);
    expect(erased.values.activity).toBeUndefined();
    expect(erased.ranges).toEqual([
      { ...talking, start: 0, end: 5 },
      { ...talking, start: 8, end: 20 },
    ]);
  });

  test('refinements inside the erased part go with it', () => {
    let draft = addRange(taxonomy, emptyDraft(), { ...standing, start: 0, end: 10 });
    draft = addRange(taxonomy, draft, { ...armsUp, start: 2, end: 8 });
    const erased = eraseRange(taxonomy, draft, standing, 0, 5, 20);
    expect(erased.ranges).toEqual([
      { ...standing, start: 5, end: 10 },
      { ...armsUp, start: 5, end: 8 },
    ]);
  });
});

describe('snapping to anchors', () => {
  test('the nearest anchor inside the tolerance wins', () => {
    expect(nearestAnchor(10.04, [9, 10, 10.1], 0.08)).toBe(10);
    expect(nearestAnchor(10.5, [9, 10], 0.08)).toBeUndefined();
  });

  test('without an anchor near, times land on frames', () => {
    expect(snapToAnchors(12.03, [10, 14], 0.05, 25)).toBe(12.04);
    expect(snapToAnchors(13.97, [10, 14], 0.05, 25)).toBe(14);
  });
});
