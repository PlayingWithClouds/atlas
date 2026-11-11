import { describe, expect, test } from 'bun:test';
import type { Suggestion } from '@atlas/contracts';
import { emptyDraft, setMoreExpanded, toggleLabel } from '../../src/core/labeling/draft';
import { acceptProposals, chooseSuggestion, probabilityOf, uncertaintyOf } from '../../src/core/labeling/suggestions';
import { taxonomy } from './fixtures';

function suggestion(source: string, values: Suggestion['values']): Suggestion {
  return { itemId: 'i1', source, values };
}

describe('chooseSuggestion', () => {
  const first = suggestion('old', {});
  const second = suggestion('probe-3', {});
  const third = suggestion('newest', {});

  test('prefers the project prefill source', () => {
    expect(chooseSuggestion([first, second, third], 'probe-3')).toBe(second);
  });

  test('falls back to the newest push when the source has nothing', () => {
    expect(chooseSuggestion([first, second, third], 'missing')).toBe(third);
    expect(chooseSuggestion([first, second, third])).toBe(third);
  });

  test('skips pushes that only carry a priority', () => {
    const withValues = suggestion('probe-1', { position: { sitting: 0.8 } });
    const priorityOnly: Suggestion = { itemId: 'i1', source: 'scenes', priority: 0.3 };
    expect(chooseSuggestion([withValues, priorityOnly])).toBe(withValues);
    expect(chooseSuggestion([priorityOnly])).toBeUndefined();
  });

  test('is undefined without suggestions', () => {
    expect(chooseSuggestion([], 'probe-3')).toBeUndefined();
  });

  test('looks up probabilities', () => {
    const proposal = suggestion('p', { position: { sitting: 0.8 } });
    expect(probabilityOf(proposal, 'position', 'sitting')).toBe(0.8);
    expect(probabilityOf(proposal, 'position', 'standing')).toBeUndefined();
    expect(probabilityOf(undefined, 'position', 'sitting')).toBeUndefined();
  });
});

describe('acceptProposals', () => {
  test('accepts only proposals of at least 0.5', () => {
    const proposal = suggestion('p', { activity: { talking: 0.5, dancing: 0.49 }, position: { sitting: 0.9 } });
    const draft = acceptProposals(taxonomy, emptyDraft(), proposal);
    expect(draft.values).toEqual({ position: ['sitting'], activity: ['talking'] });
  });

  test('a single group takes its most probable label', () => {
    const proposal = suggestion('p', { position: { sitting: 0.6, standing: 0.7 } });
    expect(acceptProposals(taxonomy, emptyDraft(), proposal).values.position).toEqual(['standing']);
  });

  test('skips collapsed groups until they are open', () => {
    const proposal = suggestion('p', { extras: { hat: 0.9 } });
    expect(acceptProposals(taxonomy, emptyDraft(), proposal).values.extras).toBeUndefined();
    expect(acceptProposals(taxonomy, setMoreExpanded(emptyDraft(), true), proposal).values.extras).toEqual(['hat']);
  });

  test('skips groups whose condition is unmet, and takes them once the condition is accepted', () => {
    const proposal = suggestion('p', { pose: { 'arms-up': 0.9 } });
    expect(acceptProposals(taxonomy, emptyDraft(), proposal).values.pose).toBeUndefined();
    const chained = suggestion('p', { position: { standing: 0.9 }, pose: { 'arms-up': 0.9 } });
    expect(acceptProposals(taxonomy, emptyDraft(), chained).values).toEqual({ position: ['standing'], pose: ['arms-up'] });
  });

  test('never overwrites what the person chose and never proposes deprecated labels', () => {
    const chosen = toggleLabel(taxonomy, emptyDraft(), taxonomy.groups[0], 'sitting');
    const proposal = suggestion('p', { position: { standing: 0.99 }, activity: { legacy: 0.99 } });
    const draft = acceptProposals(taxonomy, chosen, proposal);
    expect(draft.values.position).toEqual(['sitting']);
    expect(draft.values.activity).toBeUndefined();
  });

  test('does nothing without a suggestion', () => {
    const draft = emptyDraft();
    expect(acceptProposals(taxonomy, draft, undefined)).toBe(draft);
  });
});

describe('uncertaintyOf', () => {
  const position = taxonomy.groups.find((group) => group.id === 'position')!;
  const activity = taxonomy.groups.find((group) => group.id === 'activity')!;

  test('is 0 for a certain single choice and 1 for an even split', () => {
    expect(uncertaintyOf(suggestion('p', { position: { standing: 1, sitting: 0 } }), position)).toBeCloseTo(0);
    expect(uncertaintyOf(suggestion('p', { position: { standing: 0.5, sitting: 0.5 } }), position)).toBeCloseTo(1);
  });

  test('lets one coin-flip label decide a multi group', () => {
    const unsure = suggestion('p', { activity: { talking: 0.01, dancing: 0.5 } });
    expect(uncertaintyOf(unsure, activity)).toBeCloseTo(1);
    const sure = suggestion('p', { activity: { talking: 0.99, dancing: 0.01 } });
    expect(uncertaintyOf(sure, activity)).toBeCloseTo(0.02);
  });

  test('is undefined without probabilities for the group', () => {
    expect(uncertaintyOf(undefined, position)).toBeUndefined();
    expect(uncertaintyOf(suggestion('p', { activity: { talking: 0.5 } }), position)).toBeUndefined();
  });
});
