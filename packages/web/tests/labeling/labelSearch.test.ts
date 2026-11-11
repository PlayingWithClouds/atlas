import { describe, expect, test } from 'bun:test';
import { emptyDraft, toggleLabel } from '../../src/core/labeling/draft';
import { searchLabels } from '../../src/core/labeling/labelSearch';
import { taxonomy } from './fixtures';

function idsOf(query: string, draft = emptyDraft()): string[] {
  return searchLabels(taxonomy, draft, query).map((match) => `${match.group.id}.${match.label.id}`);
}

describe('searchLabels', () => {
  test('finds labels behind "More groups" too', () => {
    expect(idsOf('hat')).toEqual(['extras.hat']);
  });

  test('ranks name prefixes before other matches', () => {
    expect(idsOf('si')).toEqual(['position.sitting', 'position.standing']);
    expect(idsOf('ing')).toEqual(['position.standing', 'position.sitting', 'activity.talking', 'activity.dancing']);
  });

  test('matches the group name as a last resort', () => {
    expect(idsOf('extras')).toEqual(['extras.glasses', 'extras.hat']);
  });

  test('offers refinements only while their condition holds', () => {
    expect(idsOf('arms')).toEqual([]);
    const position = taxonomy.groups[0];
    const standing = toggleLabel(taxonomy, emptyDraft(), position, 'standing');
    expect(idsOf('arms', standing)).toEqual(['pose.arms-up', 'pose.arms-down']);
  });

  test('skips deprecated labels and empty queries', () => {
    expect(idsOf('legacy')).toEqual([]);
    expect(idsOf('  ')).toEqual([]);
  });
});
