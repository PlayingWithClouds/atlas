/** Maps key presses on the labeling screen to actions; free of DOM types so it is unit-testable. */

export interface KeyPress {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** Key auto-repeat while held down. */
  repeat?: boolean;
}

/** A label of the focused group, in the order shown. */
export interface KeyedLabel {
  id: string;
  hotkey?: string;
}

export type LabelAction =
  | { kind: "focusGroup"; offset: 1 | -1 }
  | { kind: "toggleLabel"; labelId: string }
  | { kind: "togglePlay" }
  | { kind: "seek"; seconds: number }
  | { kind: "save" }
  | { kind: "skip" }
  | { kind: "clearGroup" }
  | { kind: "acceptProposals" }
  | { kind: "copyPrevious" }
  | { kind: "trimStart" }
  | { kind: "trimEnd" }
  | { kind: "range" }
  | { kind: "toggleMore" }
  | { kind: "toggleMuted" }
  | { kind: "toggleReviewed" }
  | { kind: "neighbour"; offset: 1 | -1 }
  | { kind: "cheatSheet" }
  | { kind: "escape" };

export const SEEK_STEP_SECONDS = 2;

/** Keys the screen uses itself; a label hotkey on one of these is only reachable by its digit. */
export const RESERVED_KEYS = ["a", "s", "c", "r", "m", "g", "u", " ", "[", "]", "?"];

export function isReservedHotkey(hotkey: string): boolean {
  return RESERVED_KEYS.includes(hotkey.toLowerCase()) || (hotkey >= "1" && hotkey <= "9");
}

function hasCommandModifier(press: KeyPress): boolean {
  return Boolean(press.ctrlKey || press.metaKey || press.altKey);
}

const SPECIAL_KEYS: Record<string, LabelAction> = {
  ArrowUp: { kind: "focusGroup", offset: -1 },
  ArrowDown: { kind: "focusGroup", offset: 1 },
  Enter: { kind: "save" },
  Backspace: { kind: "clearGroup" },
  Delete: { kind: "clearGroup" },
  Escape: { kind: "escape" },
};

const LETTER_KEYS: Record<string, LabelAction> = {
  s: { kind: "skip" },
  a: { kind: "acceptProposals" },
  c: { kind: "copyPrevious" },
  r: { kind: "range" },
  m: { kind: "toggleMuted" },
  g: { kind: "toggleMore" },
  u: { kind: "toggleReviewed" },
  " ": { kind: "togglePlay" },
  "[": { kind: "trimStart" },
  "]": { kind: "trimEnd" },
  "?": { kind: "cheatSheet" },
};

function directionOf(key: string): 1 | -1 {
  if (key === "ArrowLeft") {
    return -1;
  }
  return 1;
}

function arrowAction(press: KeyPress): LabelAction | undefined {
  if (press.key !== "ArrowLeft" && press.key !== "ArrowRight") {
    return undefined;
  }
  const direction = directionOf(press.key);
  if (press.shiftKey) {
    return { kind: "neighbour", offset: direction };
  }
  return { kind: "seek", seconds: direction * SEEK_STEP_SECONDS };
}

function tabAction(press: KeyPress): LabelAction | undefined {
  if (press.key !== "Tab") {
    return undefined;
  }
  if (press.shiftKey) {
    return { kind: "focusGroup", offset: -1 };
  }
  return { kind: "focusGroup", offset: 1 };
}

function labelAction(key: string, labels: KeyedLabel[]): LabelAction | undefined {
  const byHotkey = labels.find((label) => label.hotkey !== undefined && label.hotkey.toLowerCase() === key.toLowerCase());
  if (byHotkey !== undefined) {
    return { kind: "toggleLabel", labelId: byHotkey.id };
  }
  if (key >= "1" && key <= "9") {
    const byDigit = labels[Number(key) - 1];
    if (byDigit !== undefined) {
      return { kind: "toggleLabel", labelId: byDigit.id };
    }
  }
  return undefined;
}

/**
 * Reserved keys win over label hotkeys (so a hotkey of "s" never skips by accident of the taxonomy),
 * then the focused group's hotkeys, then digits 1-9 by position.
 */
export function actionForKey(press: KeyPress, focusedLabels: KeyedLabel[]): LabelAction | undefined {
  if (hasCommandModifier(press)) {
    return undefined;
  }
  const special = SPECIAL_KEYS[press.key];
  if (special !== undefined) {
    return special;
  }
  const navigation = arrowAction(press);
  if (navigation !== undefined) {
    return navigation;
  }
  const tab = tabAction(press);
  if (tab !== undefined) {
    return tab;
  }
  if (press.key.length !== 1) {
    return undefined;
  }
  const reserved = LETTER_KEYS[press.key.toLowerCase()];
  if (reserved !== undefined) {
    return reserved;
  }
  return labelAction(press.key, focusedLabels);
}

export interface KeyHelp {
  keys: string[];
  action: string;
  /** Shown in the compact legend under the screen; the cheat sheet lists everything. */
  compact: boolean;
}

export const KEY_HELP: KeyHelp[] = [
  { keys: ["↑", "↓"], action: "Focus group (also Tab)", compact: true },
  { keys: ["1-9"], action: "Toggle label of the focused group", compact: true },
  { keys: ["hotkey"], action: "Toggle the label with that hotkey", compact: false },
  { keys: ["Space"], action: "Play / pause", compact: true },
  { keys: ["←", "→"], action: "Seek 2 s", compact: true },
  { keys: ["Enter"], action: "Save and open the next item", compact: true },
  { keys: ["S"], action: "Skip the item", compact: true },
  { keys: ["A"], action: "Accept suggestions of 50 % or more", compact: true },
  { keys: ["C"], action: "Copy labels from the previous scene of this video", compact: true },
  { keys: ["Backspace"], action: "Clear the focused group", compact: false },
  { keys: ["["], action: "Trim start to the playhead", compact: true },
  { keys: ["]"], action: "Trim end to the playhead", compact: true },
  { keys: ["R"], action: "Start / end a range for the focused label", compact: true },
  { keys: ["U"], action: "Mark the focused group (not) reviewed", compact: false },
  { keys: ["G"], action: "Show / hide More groups", compact: false },
  { keys: ["M"], action: "Mute / unmute", compact: false },
  { keys: ["Shift", "←/→"], action: "Previous / next scene of this video", compact: false },
  { keys: ["?"], action: "This cheat sheet", compact: true },
];
