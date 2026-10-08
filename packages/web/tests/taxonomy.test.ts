import { describe, expect, test } from 'bun:test';
import { groupsToText, textToGroups } from '../src/core/settings/taxonomy';

describe('taxonomy text', () => {
  test('round-trips groups and keeps class metadata', () => {
    const previous = [{ id: 'group', label: 'Group', classes: [{ name: 'a', icon: 'x' }, { name: 'b' }] }];
    const parsed = textToGroups(groupsToText(previous), previous);
    expect(parsed).toEqual(previous);
  });

  test('drops duplicates and puts headerless classes in a default group', () => {
    const parsed = textToGroups('one\ntwo\none', []);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].classes.map((labelClass) => labelClass.name)).toEqual(['one', 'two']);
  });
});
