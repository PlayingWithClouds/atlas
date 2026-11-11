import { describe, expect, test } from 'bun:test';
import { actionForKey, buildKeymap, chordToRecord, conflictsOf, isReservedHotkey, isRepeatable, keyHelp, normalizeChord, pressOf } from '../../src/core/labeling/keyboardMap';
import type { KeyPress, KeyedLabel, LabelAction } from '../../src/core/labeling/keyboardMap';

function press(key: string, extra: Partial<KeyPress> = {}): KeyPress {
  return { key, shiftKey: false, ...extra };
}

const labels: KeyedLabel[] = [{ id: 'talking', hotkey: 't' }, { id: 'dancing', hotkey: 'D' }, { id: 'quiet' }];

describe('actionForKey with the default keymap', () => {
  test('Tab moves between groups; arrows no longer do', () => {
    expect(actionForKey(press('Tab'), labels)).toEqual({ kind: 'focusGroup', offset: 1 });
    expect(actionForKey(press('Tab', { shiftKey: true }), labels)).toEqual({ kind: 'focusGroup', offset: -1 });
    expect(actionForKey(press('ArrowDown'), labels)).toBeUndefined();
  });

  test('left and right seek, with Shift they change item', () => {
    expect(actionForKey(press('ArrowLeft'), labels)).toEqual({ kind: 'seek', direction: -1 });
    expect(actionForKey(press('ArrowRight'), labels)).toEqual({ kind: 'seek', direction: 1 });
    expect(actionForKey(press('ArrowLeft', { shiftKey: true }), labels)).toEqual({ kind: 'neighbour', offset: -1 });
  });

  test('comma and period step frames, a jump with Shift (as "," or "<")', () => {
    expect(actionForKey(press(','), labels)).toEqual({ kind: 'stepFrames', direction: -1, jump: false });
    expect(actionForKey(press('.'), labels)).toEqual({ kind: 'stepFrames', direction: 1, jump: false });
    expect(actionForKey(press(',', { shiftKey: true }), labels)).toEqual({ kind: 'stepFrames', direction: -1, jump: true });
    expect(actionForKey(press('>', { shiftKey: true }), labels)).toEqual({ kind: 'stepFrames', direction: 1, jump: true });
  });

  test('vim-style motions and zoom', () => {
    expect(actionForKey(press('0'), labels)).toEqual({ kind: 'seekToEdge', edge: 'start' });
    expect(actionForKey(press('$', { shiftKey: true }), labels)).toEqual({ kind: 'seekToEdge', edge: 'end' });
    expect(actionForKey(press('+', { shiftKey: true }), labels)).toEqual({ kind: 'zoom', direction: 1 });
    expect(actionForKey(press('='), labels)).toEqual({ kind: 'zoom', direction: 1 });
    expect(actionForKey(press('-'), labels)).toEqual({ kind: 'zoom', direction: -1 });
  });

  test('the item actions', () => {
    expect(actionForKey(press(' '), labels)).toEqual({ kind: 'togglePlay' });
    expect(actionForKey(press('Enter', { altKey: true }), labels)).toEqual({ kind: 'save' });
    expect(actionForKey(press('Escape', { altKey: true }), labels)).toEqual({ kind: 'skip' });
    expect(actionForKey(press('Enter'), labels)).toBeUndefined();
    expect(actionForKey(press('Escape'), labels)).toEqual({ kind: 'escape' });
    expect(actionForKey(press('s'), labels)).toEqual({ kind: 'acceptHere' });
    expect(actionForKey(press('S', { shiftKey: true }), labels)).toEqual({ kind: 'acceptHere' });
    expect(actionForKey(press('Backspace'), labels)).toEqual({ kind: 'clearGroup' });
    expect(actionForKey(press('a'), labels)).toEqual({ kind: 'acceptProposals' });
    expect(actionForKey(press('c'), labels)).toEqual({ kind: 'copyPrevious' });
    expect(actionForKey(press('['), labels)).toEqual({ kind: 'trimStart' });
    expect(actionForKey(press(']'), labels)).toEqual({ kind: 'trimEnd' });
    expect(actionForKey(press('?', { shiftKey: true }), labels)).toEqual({ kind: 'cheatSheet' });
    expect(actionForKey(press('/'), labels)).toEqual({ kind: 'search' });
    expect(actionForKey(press('r'), labels)).toBeUndefined();
    expect(actionForKey(press('g'), labels)).toBeUndefined();
  });

  test('the leader starts a sequence: leader then F makes started labels whole', () => {
    expect(actionForKey(press('\\'), labels)).toEqual({ kind: 'leader' });
    expect(actionForKey(press('f', { afterLeader: true }), labels)).toEqual({ kind: 'wholeItem' });
    expect(actionForKey(press('F', { shiftKey: true, afterLeader: true }), labels)).toEqual({ kind: 'wholeItem' });
    expect(actionForKey(press('t', { afterLeader: true }), labels)).toBeUndefined();
    expect(actionForKey(press('f'), labels)).toBeUndefined();
  });

  test('hotkeys of the focused group toggle their labels, ignoring case', () => {
    expect(actionForKey(press('t'), labels)).toEqual({ kind: 'toggleLabel', labelId: 'talking' });
    expect(actionForKey(press('d', { shiftKey: true }), labels)).toEqual({ kind: 'toggleLabel', labelId: 'dancing' });
  });

  test('digits 1-9 pick labels by position', () => {
    expect(actionForKey(press('1'), labels)).toEqual({ kind: 'toggleLabel', labelId: 'talking' });
    expect(actionForKey(press('3'), labels)).toEqual({ kind: 'toggleLabel', labelId: 'quiet' });
    expect(actionForKey(press('4'), labels)).toBeUndefined();
  });

  test('bound keys win over label hotkeys, which stay reachable by digit', () => {
    const clashing: KeyedLabel[] = [{ id: 'sleepy', hotkey: 's' }];
    expect(actionForKey(press('s'), clashing)).toEqual({ kind: 'acceptHere' });
    expect(actionForKey(press('1'), clashing)).toEqual({ kind: 'toggleLabel', labelId: 'sleepy' });
    expect(isReservedHotkey('s')).toBe(true);
    expect(isReservedHotkey('\\')).toBe(true);
    expect(isReservedHotkey('t')).toBe(false);
  });

  test('ignores unrelated keys and command shortcuts', () => {
    expect(actionForKey(press('q'), labels)).toBeUndefined();
    expect(actionForKey(press('Shift'), labels)).toBeUndefined();
    expect(actionForKey(press('s', { ctrlKey: true }), labels)).toBeUndefined();
  });

  test('moving keys repeat when held, the rest do not', () => {
    expect(isRepeatable(actionForKey(press('.'), labels) as LabelAction)).toBe(true);
    expect(isRepeatable(actionForKey(press('Enter', { altKey: true }), labels) as LabelAction)).toBe(false);
  });
});

describe('real key events', () => {
  /** Like a browser KeyboardEvent: the fields are getters on the prototype, not own properties. */
  function eventLike(key: string, shiftKey = false): KeyPress {
    const prototype = {
      get key() {
        return key;
      },
      get shiftKey() {
        return shiftKey;
      },
      get ctrlKey() {
        return false;
      },
      get altKey() {
        return false;
      },
      get metaKey() {
        return false;
      },
    };
    return Object.create(prototype) as KeyPress;
  }

  test('pressOf copies prototype getters, which a spread would drop', () => {
    expect({ ...eventLike('s') }.key).toBeUndefined();
    expect(pressOf(eventLike('s'), { afterLeader: true })).toMatchObject({ key: 's', shiftKey: false, afterLeader: true });
    expect(actionForKey(pressOf(eventLike('s')), labels)).toEqual({ kind: 'acceptHere' });
  });

  test('recording a key works on event-like presses', () => {
    expect(chordToRecord(eventLike('$', true))).toBe('$');
  });
});

describe('custom keymaps', () => {
  test("overrides replace a command's keys; the old key is free for labels again", () => {
    const keymap = buildKeymap({ suggest: ['x'] });
    expect(actionForKey(press('x'), labels, keymap)).toEqual({ kind: 'acceptHere' });
    expect(actionForKey(press('s'), [{ id: 'sleepy', hotkey: 's' }], keymap)).toEqual({ kind: 'toggleLabel', labelId: 'sleepy' });
    expect(isReservedHotkey('s', keymap)).toBe(false);
  });

  test('the leader key is configurable', () => {
    const keymap = buildKeymap({}, ';');
    expect(actionForKey(press(';'), labels, keymap)).toEqual({ kind: 'leader' });
    expect(actionForKey(press('\\'), labels, keymap)).toBeUndefined();
  });

  test('conflicts list chords bound to several commands', () => {
    expect(conflictsOf({}).size).toBe(0);
    expect(conflictsOf({ mute: ['s'] }).get('s')).toHaveLength(2);
  });

  test('chords normalize modifiers and case', () => {
    expect(normalizeChord('Shift+Alt+X')).toBe('Alt+Shift+x');
    expect(normalizeChord('+')).toBe('+');
    expect(normalizeChord('<leader> F')).toBe('<leader> f');
  });

  test('recording keeps Shift for letters and named keys, not for symbols it already shaped', () => {
    expect(chordToRecord(press('$', { shiftKey: true }))).toBe('$');
    expect(chordToRecord(press('F', { shiftKey: true }))).toBe('Shift+f');
    expect(chordToRecord(press('Enter', { altKey: true }))).toBe('Alt+Enter');
    expect(chordToRecord(press('Shift', { shiftKey: true }))).toBeUndefined();
  });

  test('help shows the keys as bound, with the leader spelled out', () => {
    const help = keyHelp(buildKeymap({}, ';'));
    expect(help.find((entry) => entry.action.startsWith('Started labels hold'))?.keys).toEqual(['; f']);
  });
});
