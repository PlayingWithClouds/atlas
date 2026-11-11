import { describe, expect, test } from 'bun:test';
import { validateAnnotation } from '@atlas/contracts';
import type { Annotation } from '@atlas/contracts';
import {
  activeRefinements,
  buildAnnotationInput,
  clearGroup,
  copyValues,
  draftFromAnnotation,
  emptyDraft,
  focusableGroups,
  layoutGroups,
  reviewedGroupIds,
  setMoreExpanded,
  setNotReviewed,
  toggleLabel,
} from '../../src/core/labeling/draft';
import { taxonomy } from './fixtures';

const position = taxonomy.groups[0];
const activity = taxonomy.groups[2];

describe('reviewed rule', () => {
  test('visible active groups count as reviewed, collapsed groups stay unknown', () => {
    const reviewed = reviewedGroupIds(taxonomy, emptyDraft());
    expect(reviewed).toEqual(['position', 'activity']);
  });

  test('opening "More groups" reviews the groups behind it', () => {
    const reviewed = reviewedGroupIds(taxonomy, setMoreExpanded(emptyDraft(), true));
    expect(reviewed).toEqual(['position', 'activity', 'extras']);
  });

  test('marking a group not reviewed removes it', () => {
    const draft = setNotReviewed(emptyDraft(), 'activity', true);
    expect(reviewedGroupIds(taxonomy, draft)).toEqual(['position']);
    expect(reviewedGroupIds(taxonomy, setNotReviewed(draft, 'activity', false))).toEqual(['position', 'activity']);
  });

  test('a group with labels is reviewed even when collapsed or marked not reviewed', () => {
    let draft = toggleLabel(taxonomy, emptyDraft(), taxonomy.groups[3], 'hat');
    draft = setNotReviewed(draft, 'extras', true);
    expect(reviewedGroupIds(taxonomy, draft)).toContain('extras');
  });

  test('a conditional group is reviewed only while its condition holds', () => {
    const standing = toggleLabel(taxonomy, emptyDraft(), position, 'standing');
    expect(reviewedGroupIds(taxonomy, standing)).toEqual(['position', 'pose', 'activity']);
    const sitting = toggleLabel(taxonomy, standing, position, 'sitting');
    expect(reviewedGroupIds(taxonomy, sitting)).toEqual(['position', 'activity']);
  });

  test('what is sent passes the shared validation', () => {
    let draft = toggleLabel(taxonomy, emptyDraft(), position, 'standing');
    draft = toggleLabel(taxonomy, draft, taxonomy.groups[1], 'arms-up');
    draft = setMoreExpanded(draft, true);
    const input = buildAnnotationInput(taxonomy, draft, 'labeled');
    expect(validateAnnotation(taxonomy, input, 10)).toEqual([]);
  });
});

describe('toggling labels', () => {
  test('single groups act like radio buttons and clear when clicked again', () => {
    let draft = toggleLabel(taxonomy, emptyDraft(), position, 'standing');
    draft = toggleLabel(taxonomy, draft, position, 'sitting');
    expect(draft.values.position).toEqual(['sitting']);
    draft = toggleLabel(taxonomy, draft, position, 'sitting');
    expect(draft.values.position).toBeUndefined();
  });

  test('multi groups toggle each label independently', () => {
    let draft = toggleLabel(taxonomy, emptyDraft(), activity, 'talking');
    draft = toggleLabel(taxonomy, draft, activity, 'dancing');
    expect(draft.values.activity).toEqual(['talking', 'dancing']);
    draft = toggleLabel(taxonomy, draft, activity, 'talking');
    expect(draft.values.activity).toEqual(['dancing']);
  });

  test('turning off a condition drops the dependent group, its ranges and flags', () => {
    let draft = toggleLabel(taxonomy, emptyDraft(), position, 'standing');
    draft = toggleLabel(taxonomy, draft, taxonomy.groups[1], 'arms-up');
    draft = { ...draft, ranges: [{ group: 'pose', label: 'arms-down', start: 0, end: 1 }], notReviewed: ['pose'] };
    draft = toggleLabel(taxonomy, draft, position, 'standing');
    expect(draft.values).toEqual({});
    expect(draft.ranges).toEqual([]);
    expect(draft.notReviewed).toEqual([]);
  });

  test('clearing a group removes its values and ranges but keeps it reviewed as "none"', () => {
    let draft = toggleLabel(taxonomy, emptyDraft(), activity, 'talking');
    draft = { ...draft, ranges: [{ group: 'activity', label: 'dancing', start: 0, end: 1 }] };
    draft = clearGroup(taxonomy, draft, 'activity');
    expect(draft.values.activity).toBeUndefined();
    expect(draft.ranges).toEqual([]);
    expect(reviewedGroupIds(taxonomy, draft)).toContain('activity');
  });
});

describe('layout', () => {
  test('refinements nest under the group they refine, only while active; "more" groups are separate', () => {
    expect(layoutGroups(taxonomy, emptyDraft()).primary.map((group) => group.id)).toEqual(['position', 'activity']);
    expect(activeRefinements(taxonomy, emptyDraft(), 'position')).toEqual([]);
    const standing = toggleLabel(taxonomy, emptyDraft(), position, 'standing');
    expect(layoutGroups(taxonomy, standing).primary.map((group) => group.id)).toEqual(['position', 'activity']);
    expect(activeRefinements(taxonomy, standing, 'position').map((group) => group.id)).toEqual(['pose']);
    expect(layoutGroups(taxonomy, standing).more.map((group) => group.id)).toEqual(['extras']);
  });

  test('arrow navigation visits a refinement right after its group', () => {
    const standing = toggleLabel(taxonomy, emptyDraft(), position, 'standing');
    expect(focusableGroups(taxonomy, standing).map((group) => group.id)).toEqual(['position', 'pose', 'activity']);
  });

  test('arrow navigation reaches "more" groups only once they are open', () => {
    expect(focusableGroups(taxonomy, emptyDraft()).map((group) => group.id)).toEqual(['position', 'activity']);
    const open = setMoreExpanded(emptyDraft(), true);
    expect(focusableGroups(taxonomy, open).map((group) => group.id)).toEqual(['position', 'activity', 'extras']);
  });

  test('a group of only deprecated, unused labels is hidden', () => {
    const retired = {
      ...taxonomy,
      groups: [{ id: 'old', label: 'Old', kind: 'multi' as const, primary: true, labels: [{ id: 'x', name: 'X', deprecated: true }] }],
    };
    expect(layoutGroups(retired, emptyDraft()).primary).toEqual([]);
  });
});

describe('annotation round trip', () => {
  const annotation: Annotation = {
    itemId: 'i1',
    status: 'labeled',
    values: { position: ['sitting'] },
    reviewed: ['position', 'extras'],
    taxonomyVersion: 3,
    updatedAt: '2026-01-01T00:00:00Z',
  };

  test('reopening shows visible groups the annotation did not review as "not reviewed"', () => {
    const draft = draftFromAnnotation(taxonomy, annotation);
    expect(draft.notReviewed).toEqual(['activity']);
    expect(draft.moreExpanded).toBe(true);
    expect(reviewedGroupIds(taxonomy, draft)).toEqual(['position', 'extras']);
  });

  test('a skipped or missing annotation reopens empty', () => {
    expect(draftFromAnnotation(taxonomy, undefined)).toEqual(emptyDraft());
    expect(draftFromAnnotation(taxonomy, { ...annotation, status: 'skipped', reviewed: [] })).toEqual(emptyDraft());
  });

  test('a skip sends nothing', () => {
    const draft = toggleLabel(taxonomy, emptyDraft(), position, 'sitting');
    expect(buildAnnotationInput(taxonomy, draft, 'skipped')).toEqual({ status: 'skipped', values: {}, reviewed: [] });
  });
});

describe('copying from the previous item', () => {
  test('takes over known labels, drops unknown ids and unmet conditions', () => {
    const source = { position: ['sitting'], pose: ['arms-up'], activity: ['talking', 'gone'], missing: ['x'] };
    const draft = copyValues(taxonomy, emptyDraft(), source);
    expect(draft.values).toEqual({ position: ['sitting'], activity: ['talking'] });
  });

  test('keeps the pose when the copied position allows it', () => {
    const draft = copyValues(taxonomy, emptyDraft(), { position: ['standing'], pose: ['arms-up'] });
    expect(draft.values).toEqual({ position: ['standing'], pose: ['arms-up'] });
  });
});
