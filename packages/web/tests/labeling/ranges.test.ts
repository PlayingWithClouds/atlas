import { describe, expect, test } from 'bun:test';
import { validateAnnotation } from '@atlas/contracts';
import { buildAnnotationInput, emptyDraft, toggleLabel } from '../../src/core/labeling/draft';
import { addRange, effectiveSpan, itemTimeOf, removeRange, stepRange, trimEdge } from '../../src/core/labeling/ranges';
import { taxonomy } from './fixtures';

const talking = { group: 'activity', label: 'talking' };

describe('building ranges', () => {
  test('the first press starts, the second ends the range', () => {
    const started = stepRange(undefined, talking, 2);
    expect(started.pending).toEqual({ ...talking, start: 2 });
    const ended = stepRange(started.pending, talking, 5);
    expect(ended.range).toEqual({ ...talking, start: 2, end: 5 });
    expect(ended.pending).toBeUndefined();
  });

  test('ending before the start swaps the edges', () => {
    const ended = stepRange({ ...talking, start: 5 }, talking, 2);
    expect(ended.range).toEqual({ ...talking, start: 2, end: 5 });
  });

  test('a range of no length is refused and keeps waiting', () => {
    const pending = { ...talking, start: 2 };
    const step = stepRange(pending, talking, 2.01);
    expect(step.range).toBeUndefined();
    expect(step.pending).toBe(pending);
    expect(step.problem).toBeDefined();
  });

  test('another label restarts the range there', () => {
    const step = stepRange({ ...talking, start: 2 }, { group: 'activity', label: 'dancing' }, 4);
    expect(step.pending).toEqual({ group: 'activity', label: 'dancing', start: 4 });
  });

  test('converts asset time to item time inside the item', () => {
    expect(itemTimeOf(112, 100, 20)).toBe(12);
    expect(itemTimeOf(90, 100, 20)).toBe(0);
    expect(itemTimeOf(140, 100, 20)).toBe(20);
    expect(itemTimeOf(140, 100, undefined)).toBe(40);
  });
});

describe('adding ranges to a draft', () => {
  const activity = taxonomy.groups[2];

  test('a label that gets a range no longer holds for the whole item', () => {
    let draft = toggleLabel(taxonomy, emptyDraft(), activity, 'talking');
    draft = addRange(taxonomy, draft, { ...talking, start: 1, end: 3 });
    expect(draft.values.activity).toBeUndefined();
    expect(draft.ranges).toHaveLength(1);
    const input = buildAnnotationInput(taxonomy, draft, 'labeled');
    expect(input.reviewed).toContain('activity');
    expect(validateAnnotation(taxonomy, input, 10)).toEqual([]);
  });

  test('multi groups may overlap, single groups replace what the new range overlaps', () => {
    let multi = addRange(taxonomy, emptyDraft(), { ...talking, start: 0, end: 4 });
    multi = addRange(taxonomy, multi, { group: 'activity', label: 'dancing', start: 2, end: 6 });
    expect(multi.ranges).toHaveLength(2);

    let single = addRange(taxonomy, emptyDraft(), { group: 'position', label: 'sitting', start: 0, end: 4 });
    single = addRange(taxonomy, single, { group: 'position', label: 'standing', start: 3, end: 6 });
    single = addRange(taxonomy, single, { group: 'position', label: 'sitting', start: 8, end: 9 });
    expect(single.ranges.map((range) => range.label)).toEqual(['standing', 'sitting']);
    expect(validateAnnotation(taxonomy, buildAnnotationInput(taxonomy, single, 'labeled'), 10)).toEqual([]);
  });

  test('removing a range leaves the others', () => {
    let draft = addRange(taxonomy, emptyDraft(), { ...talking, start: 0, end: 1 });
    draft = addRange(taxonomy, draft, { ...talking, start: 2, end: 3 });
    const removed = removeRange(draft, draft.ranges[0]);
    expect(removed.ranges).toEqual([{ ...talking, start: 2, end: 3 }]);
  });
});

describe('trimming', () => {
  const span = { start: 100, end: 120 };

  test('sets the start and the end at the playhead', () => {
    expect(trimEdge('start', 105, span, undefined, 300).span).toEqual({ start: 105, end: 120 });
    expect(trimEdge('end', 115, span, { start: 105, end: 120 }, 300).span).toEqual({ start: 105, end: 115 });
  });

  test('trimming back to the item span clears the trim', () => {
    expect(trimEdge('start', 100, span, { start: 105, end: 120 }, 300).span).toBeUndefined();
  });

  test('refuses a start after the end and keeps the old trim', () => {
    const trimmed = { start: 105, end: 110 };
    const step = trimEdge('start', 111, span, trimmed, 300);
    expect(step.problem).toBeDefined();
    expect(step.span).toBe(trimmed);
  });

  test('stays inside the asset', () => {
    expect(trimEdge('end', 400, span, undefined, 300).span).toEqual({ start: 100, end: 300 });
  });

  test('an item without a span trims against the whole asset', () => {
    expect(trimEdge('start', 10, undefined, undefined, 60).span).toEqual({ start: 10, end: 60 });
    expect(trimEdge('start', 10, undefined, undefined, undefined).problem).toBeDefined();
  });

  test('the loop window is the trim, else the item span, else the whole asset', () => {
    expect(effectiveSpan(span, { start: 1, end: 2 }, 300)).toEqual({ start: 1, end: 2 });
    expect(effectiveSpan(span, undefined, 300)).toEqual(span);
    expect(effectiveSpan(undefined, undefined, 300)).toEqual({ start: 0, end: 300 });
    expect(effectiveSpan(undefined, undefined, undefined)).toBeUndefined();
  });
});
