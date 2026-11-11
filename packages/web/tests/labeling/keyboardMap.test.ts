import { describe, expect, test } from 'bun:test';
import { actionForKey, isReservedHotkey } from '../../src/core/labeling/keyboardMap';
import type { KeyPress, KeyedLabel } from '../../src/core/labeling/keyboardMap';

function press(key: string, extra: Partial<KeyPress> = {}): KeyPress {
  return { key, shiftKey: false, ...extra };
}

const labels: KeyedLabel[] = [{ id: 'talking', hotkey: 't' }, { id: 'dancing', hotkey: 'D' }, { id: 'quiet' }];

describe('actionForKey', () => {
  test('arrows and Tab move between groups', () => {
    expect(actionForKey(press('ArrowDown'), labels)).toEqual({ kind: 'focusGroup', offset: 1 });
    expect(actionForKey(press('ArrowUp'), labels)).toEqual({ kind: 'focusGroup', offset: -1 });
    expect(actionForKey(press('Tab'), labels)).toEqual({ kind: 'focusGroup', offset: 1 });
    expect(actionForKey(press('Tab', { shiftKey: true }), labels)).toEqual({ kind: 'focusGroup', offset: -1 });
  });

  test('left and right seek two seconds, with Shift they change item', () => {
    expect(actionForKey(press('ArrowLeft'), labels)).toEqual({ kind: 'seek', seconds: -2 });
    expect(actionForKey(press('ArrowRight'), labels)).toEqual({ kind: 'seek', seconds: 2 });
    expect(actionForKey(press('ArrowLeft', { shiftKey: true }), labels)).toEqual({ kind: 'neighbour', offset: -1 });
    expect(actionForKey(press('ArrowRight', { shiftKey: true }), labels)).toEqual({ kind: 'neighbour', offset: 1 });
  });

  test('comma and period step frames, ten with Shift', () => {
    expect(actionForKey(press(','), labels)).toEqual({ kind: 'stepFrames', count: -1 });
    expect(actionForKey(press('.'), labels)).toEqual({ kind: 'stepFrames', count: 1 });
    expect(actionForKey(press(',', { shiftKey: true }), labels)).toEqual({ kind: 'stepFrames', count: -10 });
    expect(actionForKey(press('>', { shiftKey: true }), labels)).toEqual({ kind: 'stepFrames', count: 10 });
    expect(isReservedHotkey('.')).toBe(true);
  });

  test('the item actions', () => {
    expect(actionForKey(press(' '), labels)).toEqual({ kind: 'togglePlay' });
    expect(actionForKey(press('Enter', { altKey: true }), labels)).toEqual({ kind: 'save' });
    expect(actionForKey(press('Escape', { altKey: true }), labels)).toEqual({ kind: 'skip' });
    expect(actionForKey(press('Enter'), labels)).toBeUndefined();
    expect(actionForKey(press('s'), labels)).toEqual({ kind: 'acceptHere' });
    expect(actionForKey(press('S', { shiftKey: true }), labels)).toEqual({ kind: 'acceptHere' });
    expect(actionForKey(press('Backspace'), labels)).toEqual({ kind: 'clearGroup' });
    expect(actionForKey(press('a'), labels)).toEqual({ kind: 'acceptProposals' });
    expect(actionForKey(press('c'), labels)).toEqual({ kind: 'copyPrevious' });
    expect(actionForKey(press('['), labels)).toEqual({ kind: 'trimStart' });
    expect(actionForKey(press(']'), labels)).toEqual({ kind: 'trimEnd' });
    expect(actionForKey(press('r'), labels)).toEqual({ kind: 'range' });
    expect(actionForKey(press('?', { shiftKey: true }), labels)).toEqual({ kind: 'cheatSheet' });
    expect(actionForKey(press('/'), labels)).toEqual({ kind: 'search' });
    expect(actionForKey(press('F', { shiftKey: true }), labels)).toEqual({ kind: 'wholeItem' });
    expect(actionForKey(press('/', { shiftKey: true }), labels)).toEqual({ kind: 'search' });
  });

  test('hotkeys of the focused group toggle their labels, ignoring case', () => {
    expect(actionForKey(press('t'), labels)).toEqual({ kind: 'toggleLabel', labelId: 'talking' });
    expect(actionForKey(press('d'), labels)).toEqual({ kind: 'toggleLabel', labelId: 'dancing' });
    expect(actionForKey(press('d', { shiftKey: true }), labels)).toEqual({ kind: 'toggleLabel', labelId: 'dancing' });
  });

  test('digits pick labels by position, only as many as there are', () => {
    expect(actionForKey(press('1'), labels)).toEqual({ kind: 'toggleLabel', labelId: 'talking' });
    expect(actionForKey(press('3'), labels)).toEqual({ kind: 'toggleLabel', labelId: 'quiet' });
    expect(actionForKey(press('4'), labels)).toBeUndefined();
    expect(actionForKey(press('0'), labels)).toBeUndefined();
  });

  test('reserved keys win over label hotkeys, which stay reachable by digit', () => {
    const clashing: KeyedLabel[] = [{ id: 'sleepy', hotkey: 's' }];
    expect(actionForKey(press('s'), clashing)).toEqual({ kind: 'acceptHere' });
    expect(actionForKey(press('1'), clashing)).toEqual({ kind: 'toggleLabel', labelId: 'sleepy' });
    expect(isReservedHotkey('s')).toBe(true);
    expect(isReservedHotkey('t')).toBe(false);
  });

  test('ignores unrelated keys and command shortcuts', () => {
    expect(actionForKey(press('q'), labels)).toBeUndefined();
    expect(actionForKey(press('Shift'), labels)).toBeUndefined();
    expect(actionForKey(press('s', { ctrlKey: true }), labels)).toBeUndefined();
    expect(actionForKey(press('Enter', { metaKey: true }), labels)).toBeUndefined();
  });
});
