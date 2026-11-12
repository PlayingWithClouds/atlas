import { describe, expect, test } from 'bun:test';
import type { Suggestion } from '@atlas/contracts';
import { emptyDraft, setNotReviewed, toggleLabel } from '../../src/core/labeling/draft';
import { addRange } from '../../src/core/labeling/ranges';
import { confidentAdditions, emptyAutoAdded, personsAnnotation, rangeKey, valueKey } from '../../src/core/labeling/liveSuggestions';
import { taxonomy } from './fixtures';

const position = taxonomy.groups[0];
const activity = taxonomy.groups[2];

function live(values: Suggestion['values'], ranges: Suggestion['ranges'] = []): Suggestion {
  return { itemId: 'i1', source: 'live', values, ranges };
}

describe('personsAnnotation', () => {
  test('leaves out auto-added labels and counts only labeled groups as reviewed', () => {
    let draft = toggleLabel(taxonomy, emptyDraft(), activity, 'talking');
    draft = toggleLabel(taxonomy, draft, position, 'sitting');
    const talk = { group: 'activity', label: 'dancing', start: 1, end: 2 };
    draft = addRange(taxonomy, draft, talk);
    const autoAdded = emptyAutoAdded();
    autoAdded.values.add(valueKey('position', 'sitting'));
    autoAdded.ranges.add(rangeKey(talk));

    const annotation = personsAnnotation(draft, autoAdded);

    expect(annotation.values).toEqual({ activity: ['talking'] });
    expect(annotation.ranges).toEqual([]);
    expect(annotation.reviewed).toEqual(['activity']);
  });

  test('an empty draft teaches nothing, not "none of these" for every visible group', () => {
    expect(personsAnnotation(emptyDraft(), emptyAutoAdded())).toEqual({ values: {}, ranges: [], reviewed: [] });
  });
});

describe('confidentAdditions', () => {
  test('adds values and ranges at or above the threshold only', () => {
    const suggestion = live(
      { position: { standing: 0.95, sitting: 0.05 }, activity: { talking: 0.89 } },
      [{ group: 'activity', label: 'dancing', start: 2, end: 4, score: 0.93 }],
    );
    const additions = confidentAdditions(taxonomy, emptyDraft(), suggestion, 0.9, emptyAutoAdded());
    expect(additions.values.map((value) => `${value.group.id}.${value.label}`)).toEqual(['position.standing']);
    expect(additions.ranges).toEqual([{ group: 'activity', label: 'dancing', start: 2, end: 4 }]);
  });

  test('never overrides a single group the person already set', () => {
    const draft = toggleLabel(taxonomy, emptyDraft(), position, 'sitting');
    const additions = confidentAdditions(taxonomy, draft, live({ position: { standing: 0.99 } }), 0.9, emptyAutoAdded());
    expect(additions.values).toEqual([]);
  });

  test('skips deprecated labels, inactive groups and groups marked not reviewed', () => {
    const draft = setNotReviewed(emptyDraft(), 'extras', true);
    const suggestion = live({ activity: { legacy: 0.99 }, pose: { 'arms-up': 0.99 }, extras: { hat: 0.99 } });
    expect(confidentAdditions(taxonomy, draft, suggestion, 0.9, emptyAutoAdded()).values).toEqual([]);
  });

  test('does not bring back what the person removed', () => {
    const offered = emptyAutoAdded();
    offered.values.add(valueKey('position', 'standing'));
    offered.ranges.add(rangeKey({ group: 'activity', label: 'dancing', start: 2, end: 4 }));
    const suggestion = live(
      { position: { standing: 0.99 } },
      [{ group: 'activity', label: 'dancing', start: 2.2, end: 4.4, score: 0.95 }],
    );
    const additions = confidentAdditions(taxonomy, emptyDraft(), suggestion, 0.9, offered);
    expect(additions.values).toEqual([]);
    expect(additions.ranges).toEqual([]);
  });

  test('a range overlapping the same label already drawn is not added', () => {
    const draft = addRange(taxonomy, emptyDraft(), { group: 'activity', label: 'dancing', start: 1, end: 3 });
    const suggestion = live({}, [{ group: 'activity', label: 'dancing', start: 2, end: 5, score: 0.97 }]);
    expect(confidentAdditions(taxonomy, draft, suggestion, 0.9, emptyAutoAdded()).ranges).toEqual([]);
  });
});
