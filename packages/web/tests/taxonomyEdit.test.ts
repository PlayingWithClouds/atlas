import { describe, expect, test } from 'bun:test';
import type { Group } from '@atlas/contracts';
import {
  newGroup,
  newLabel,
  parseTaxonomyJson,
  slugify,
  taxonomyProblems,
  taxonomyToJson,
  taxonomyWarnings,
  uniqueId,
} from '../src/core/taxonomy/taxonomyEdit';
import { taxonomy } from './labeling/fixtures';

describe('ids', () => {
  test('slugify produces valid ids', () => {
    expect(slugify('Arms up!')).toBe('arms-up');
    expect(slugify('  Café  au lait ')).toBe('cafe-au-lait');
    expect(slugify('***')).toBe('');
  });

  test('uniqueId avoids taken ids', () => {
    expect(uniqueId('Pose', [])).toBe('pose');
    expect(uniqueId('Pose', ['pose', 'pose-2'])).toBe('pose-3');
    expect(uniqueId('???', [])).toBe('item-2');
  });

  test('new groups and labels get ids that do not clash', () => {
    const first = newGroup(taxonomy.groups);
    expect(first.id).toBe('group');
    const second = newGroup([...taxonomy.groups, first]);
    expect(second.id).toBe('group-2');
    expect(newLabel(taxonomy.groups[0]).id).toBe('label');
  });
});

describe('JSON import and export', () => {
  test('round-trips the groups', () => {
    const parsed = parseTaxonomyJson(taxonomyToJson(taxonomy.groups));
    expect(parsed.problems).toEqual([]);
    expect(parsed.groups).toEqual(taxonomy.groups);
  });

  test('accepts a bare list of groups', () => {
    expect(parseTaxonomyJson(JSON.stringify(taxonomy.groups)).groups).toHaveLength(taxonomy.groups.length);
  });

  test('explains bad input instead of throwing', () => {
    expect(parseTaxonomyJson('{nope').problems[0]).toContain('not valid JSON');
    expect(parseTaxonomyJson('{"groups": 3}').problems).toHaveLength(1);
    expect(parseTaxonomyJson('[{"id": "a", "label": "A"}]').problems[0]).toContain('"labels"');
    expect(parseTaxonomyJson('[{"id": "a", "label": "A", "labels": [{"id": 1}]}]').problems).toHaveLength(2);
  });
});

describe('problems', () => {
  test('no problems for an unchanged taxonomy', () => {
    expect(taxonomyProblems(taxonomy, taxonomy.groups)).toEqual([]);
  });

  test('uses the shared validation', () => {
    const groups: Group[] = [...taxonomy.groups, { id: 'Bad Id', label: 'x', kind: 'single', labels: [] }];
    expect(taxonomyProblems(taxonomy, groups).join('\n')).toContain('must be lowercase');
  });

  test('refuses to drop saved groups and labels', () => {
    const groups = taxonomy.groups.slice(1).map((group) => ({ ...group, when: undefined }));
    const problems = taxonomyProblems(taxonomy, groups);
    expect(problems.some((problem) => problem.includes('"position"'))).toBe(true);
    const fewerLabels = taxonomy.groups.map((group) => ({ ...group, labels: group.labels.slice(0, 1) }));
    expect(taxonomyProblems(taxonomy, fewerLabels).some((problem) => problem.includes('position.sitting'))).toBe(true);
  });

  test('warns about hotkeys the labeling screen keeps for itself', () => {
    const groups: Group[] = [{ id: 'g', label: 'G', kind: 'single', labels: [{ id: 'l', name: 'L', hotkey: 's' }] }];
    expect(taxonomyWarnings(groups)).toHaveLength(1);
    expect(taxonomyWarnings(taxonomy.groups)).toEqual([]);
  });
});
