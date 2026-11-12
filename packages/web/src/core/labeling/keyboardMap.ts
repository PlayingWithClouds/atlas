/**
 * Maps key presses on the labeling screen to actions; free of DOM types so it is unit-testable.
 *
 * Every action is a named command with default key chords. A keymap (defaults plus the person's
 * overrides from Settings) maps chords to commands. Chords read like "s", "Shift+,", "Alt+Enter",
 * "Space", or "<leader> f" for a key pressed right after the leader key.
 */

export interface KeyPress {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** Key auto-repeat while held down. */
  repeat?: boolean;
  /** The leader key came right before this press. */
  afterLeader?: boolean;
}

/**
 * A plain copy of a press. KeyboardEvent keeps `key`, `shiftKey` … as getters on its prototype,
 * so `{ ...event }` copies none of them: always copy through this instead of spreading.
 */
export function pressOf(event: KeyPress, change: Partial<KeyPress> = {}): KeyPress {
  return {
    key: event.key,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    repeat: event.repeat,
    afterLeader: event.afterLeader,
    ...change,
  };
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
  | { kind: "seek"; direction: 1 | -1 }
  | { kind: "stepFrames"; direction: 1 | -1; jump: boolean }
  | { kind: "seekToEdge"; edge: "start" | "end" }
  | { kind: "zoom"; direction: 1 | -1 }
  | { kind: "save" }
  | { kind: "skip" }
  | { kind: "clearGroup" }
  | { kind: "acceptProposals" }
  | { kind: "copyPrevious" }
  | { kind: "trimStart" }
  | { kind: "trimEnd" }
  | { kind: "toggleMuted" }
  | { kind: "toggleReviewed" }
  | { kind: "neighbour"; offset: 1 | -1 }
  | { kind: "cheatSheet" }
  | { kind: "search" }
  | { kind: "wholeItem" }
  | { kind: "acceptHere" }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "leader" }
  | { kind: "escape" };

export interface Command {
  id: string;
  action: LabelAction;
  /** What it does, for Settings and the cheat sheet. */
  title: string;
  defaults: string[];
  /** Runs again while the key is held down. */
  repeat?: boolean;
  /** One word for the compact legend under the screen; unset keeps it out of the legend. */
  short?: string;
}

export const LEADER_PREFIX = "<leader> ";
/** Vim's default leader; Space is play / pause. */
export const DEFAULT_LEADER = "\\";

export const COMMANDS: Command[] = [
  { id: "focusNext", action: { kind: "focusGroup", offset: 1 }, title: "Focus the next group", defaults: ["Tab"], repeat: true, short: "group" },
  { id: "focusPrevious", action: { kind: "focusGroup", offset: -1 }, title: "Focus the previous group", defaults: ["Shift+Tab"], repeat: true },
  { id: "search", action: { kind: "search" }, title: "Search a label; Enter starts it at the playhead (again: drops it)", defaults: ["/"], short: "search" },
  { id: "endHere", action: { kind: "trimEnd" }, title: "End started labels at the playhead; else the selected range (else the item) ends there", defaults: ["]"], short: "end" },
  { id: "startHere", action: { kind: "trimStart" }, title: "Started labels restart at the playhead; else the selected range (else the item) starts there", defaults: ["["] },
  { id: "wholeScene", action: { kind: "wholeItem" }, title: "Started labels hold for the whole scene instead", defaults: ["<leader> f"], short: "whole" },
  { id: "suggest", action: { kind: "acceptHere" }, title: "Pick from the model's suggestions at the playhead", defaults: ["s"], short: "suggest" },
  { id: "togglePlay", action: { kind: "togglePlay" }, title: "Play / pause", defaults: ["Space"], short: "play" },
  { id: "seekBack", action: { kind: "seek", direction: -1 }, title: "Seek back", defaults: ["ArrowLeft"], repeat: true, short: "seek" },
  { id: "seekForward", action: { kind: "seek", direction: 1 }, title: "Seek forward", defaults: ["ArrowRight"], repeat: true },
  { id: "frameBack", action: { kind: "stepFrames", direction: -1, jump: false }, title: "One frame back", defaults: [","], repeat: true, short: "frame" },
  { id: "frameForward", action: { kind: "stepFrames", direction: 1, jump: false }, title: "One frame forward", defaults: ["."], repeat: true },
  // Shift+, arrives as "<" on many layouts, so both are bound.
  { id: "framesBack", action: { kind: "stepFrames", direction: -1, jump: true }, title: "Several frames back", defaults: ["Shift+,", "<"], repeat: true },
  { id: "framesForward", action: { kind: "stepFrames", direction: 1, jump: true }, title: "Several frames forward", defaults: ["Shift+.", ">"], repeat: true },
  { id: "sceneStart", action: { kind: "seekToEdge", edge: "start" }, title: "Playhead to the scene start", defaults: ["0"], short: "start" },
  { id: "sceneEnd", action: { kind: "seekToEdge", edge: "end" }, title: "Playhead to the scene end", defaults: ["$"], short: "end of scene" },
  { id: "zoomIn", action: { kind: "zoom", direction: 1 }, title: "Zoom the timeline in", defaults: ["+", "="], repeat: true, short: "zoom" },
  { id: "zoomOut", action: { kind: "zoom", direction: -1 }, title: "Zoom the timeline out", defaults: ["-"], repeat: true },
  { id: "previousScene", action: { kind: "neighbour", offset: -1 }, title: "Previous scene of this video", defaults: ["Shift+ArrowLeft"] },
  { id: "nextScene", action: { kind: "neighbour", offset: 1 }, title: "Next scene of this video", defaults: ["Shift+ArrowRight"] },
  { id: "save", action: { kind: "save" }, title: "Save and open the next item", defaults: ["Alt+Enter"], short: "save" },
  { id: "skip", action: { kind: "skip" }, title: "Skip the item", defaults: ["Alt+Escape"], short: "skip" },
  { id: "accept", action: { kind: "acceptProposals" }, title: "Accept whole-scene proposals of 50 % or more", defaults: ["a"], short: "accept" },
  { id: "copyPrevious", action: { kind: "copyPrevious" }, title: "Copy labels from the previous scene of this video", defaults: ["c"] },
  { id: "clearGroup", action: { kind: "clearGroup" }, title: "Delete the selected range, else clear the focused group", defaults: ["Backspace", "Delete"] },
  { id: "undo", action: { kind: "undo" }, title: "Undo the last change to the labels", defaults: ["Ctrl+z", "Meta+z"], repeat: true, short: "undo" },
  { id: "redo", action: { kind: "redo" }, title: "Redo what was undone", defaults: ["Ctrl+Shift+z", "Meta+Shift+z", "Ctrl+y"], repeat: true },
  { id: "escape", action: { kind: "escape" }, title: "Drop started labels, deselect the range, stop looping it", defaults: ["Escape"] },
  { id: "reviewed", action: { kind: "toggleReviewed" }, title: "Mark the focused group (not) reviewed", defaults: ["u"] },
  { id: "mute", action: { kind: "toggleMuted" }, title: "Mute / unmute", defaults: ["m"] },
  { id: "cheatSheet", action: { kind: "cheatSheet" }, title: "All keys", defaults: ["?"], short: "all keys" },
];

/** Chords per command id, as the person set them; commands left out keep their defaults. */
export type Bindings = Record<string, string[]>;

export interface Keymap {
  /** Normalized chord → command. */
  byChord: Map<string, Command>;
  /** Command id → its chords as set. */
  chordsOf: Map<string, string[]>;
  leader: string;
}

function chordsFor(command: Command, overrides: Bindings): string[] {
  const override = overrides[command.id];
  if (override !== undefined) {
    return override;
  }
  return command.defaults;
}

export function buildKeymap(overrides: Bindings = {}, leader: string = DEFAULT_LEADER): Keymap {
  const byChord = new Map<string, Command>();
  const chordsOf = new Map<string, string[]>();
  for (const command of COMMANDS) {
    const chords = chordsFor(command, overrides);
    chordsOf.set(command.id, chords);
    for (const chord of chords) {
      byChord.set(normalizeChord(chord), command);
    }
  }
  return { byChord, chordsOf, leader: keyName(leader) };
}

export const DEFAULT_KEYMAP = buildKeymap();

/** Chords bound to more than one command, with those commands' titles. */
export function conflictsOf(overrides: Bindings): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const command of COMMANDS) {
    for (const chord of chordsFor(command, overrides)) {
      const normalized = normalizeChord(chord);
      const titles = owners.get(normalized);
      if (titles === undefined) {
        owners.set(normalized, [command.title]);
      } else {
        titles.push(command.title);
      }
    }
  }
  return new Map([...owners].filter(([, titles]) => titles.length > 1));
}

// --- chords ---------------------------------------------------------------------------------

/** Letters compare case-insensitively; Space gets a name. */
function keyName(key: string): string {
  if (key === " ") {
    return "Space";
  }
  if (key.length === 1) {
    return key.toLowerCase();
  }
  return key;
}

export function normalizeChord(chord: string): string {
  let rest = chord;
  let prefix = "";
  if (rest.startsWith(LEADER_PREFIX)) {
    prefix = LEADER_PREFIX;
    rest = rest.slice(LEADER_PREFIX.length);
  }
  const parts = rest.split("+");
  let key = parts[parts.length - 1];
  let modifiers = parts.slice(0, -1);
  // "+" and "Shift++" split into empty parts: the key itself is "+".
  if (key === "" && parts.length >= 2) {
    key = "+";
    modifiers = parts.slice(0, -2).filter((part) => part !== "");
  }
  const ordered = ["Ctrl", "Alt", "Meta", "Shift"].filter((modifier) => modifiers.includes(modifier));
  return prefix + [...ordered, keyName(key)].join("+");
}

function modifiersOf(press: KeyPress, withShift: boolean): string[] {
  const modifiers: string[] = [];
  if (press.ctrlKey) modifiers.push("Ctrl");
  if (press.altKey) modifiers.push("Alt");
  if (press.metaKey) modifiers.push("Meta");
  if (withShift && press.shiftKey) modifiers.push("Shift");
  return modifiers;
}

/**
 * The chords a press can stand for, most specific first: with Shift, then without, since Shift
 * often only changes the character ("$" is Shift+4, so "$" alone must match).
 */
export function chordsOfPress(press: KeyPress): string[] {
  const key = keyName(press.key);
  let prefix = "";
  if (press.afterLeader) {
    prefix = LEADER_PREFIX;
  }
  const exact = prefix + [...modifiersOf(press, true), key].join("+");
  const unshifted = prefix + [...modifiersOf(press, false), key].join("+");
  if (exact === unshifted) {
    return [exact];
  }
  return [exact, unshifted];
}

const MODIFIER_KEYS = ["Shift", "Control", "Alt", "Meta", "AltGraph"];

/** The chord to record for a press in Settings; undefined for a lone modifier key. */
export function chordToRecord(press: KeyPress): string | undefined {
  if (MODIFIER_KEYS.includes(press.key)) {
    return undefined;
  }
  // A printable key already carries its Shift ("$"), letters aside ("Shift+f").
  const printable = press.key.length === 1 && press.key.toLowerCase() === press.key.toUpperCase();
  if (printable) {
    return chordsOfPress(pressOf(press, { shiftKey: false }))[0];
  }
  return chordsOfPress(press)[0];
}

/** Whether a press is a modifier key on its own (Settings waits for the real key). */
export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.includes(key);
}

export function isRepeatable(action: LabelAction): boolean {
  const command = COMMANDS.find((candidate) => candidate.action === action);
  return command !== undefined && command.repeat === true;
}

// --- labels -----------------------------------------------------------------------------------

/** Keys bound to a command; a label hotkey on one of these is only reachable by its digit. */
export function isReservedHotkey(hotkey: string, keymap: Keymap = DEFAULT_KEYMAP): boolean {
  if (hotkey >= "1" && hotkey <= "9") {
    return true;
  }
  return keymap.byChord.has(keyName(hotkey)) || keyName(hotkey) === keymap.leader;
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

function hasCommandModifier(press: KeyPress): boolean {
  return Boolean(press.ctrlKey || press.metaKey || press.altKey);
}

function isLeader(press: KeyPress, keymap: Keymap): boolean {
  return press.afterLeader !== true && !hasCommandModifier(press) && keyName(press.key) === keymap.leader;
}

/**
 * The leader starts a sequence; then bound chords win over label hotkeys (so a hotkey of "s"
 * never opens the suggestions by accident of the taxonomy), then the focused group's hotkeys,
 * then digits 1-9.
 */
export function actionForKey(press: KeyPress, focusedLabels: KeyedLabel[], keymap: Keymap = DEFAULT_KEYMAP): LabelAction | undefined {
  if (isLeader(press, keymap)) {
    return { kind: "leader" };
  }
  for (const chord of chordsOfPress(press)) {
    const command = keymap.byChord.get(chord);
    if (command !== undefined) {
      return command.action;
    }
  }
  if (press.afterLeader || hasCommandModifier(press) || press.key.length !== 1) {
    return undefined;
  }
  return labelAction(press.key, focusedLabels);
}

// --- help -------------------------------------------------------------------------------------

export interface KeyHelp {
  keys: string[];
  action: string;
  /** Shown in the compact legend under the screen; the cheat sheet lists everything. */
  compact: boolean;
  /** One word for the compact legend. */
  short?: string;
}

const POINTER_HELP: KeyHelp[] = [
  { keys: ["1-9"], action: "Toggle label of the focused group", compact: false },
  { keys: ["hotkey"], action: "Toggle the label with that hotkey", compact: false },
  { keys: ["drag"], action: "In a timeline track: mark the part of the item a label holds for", compact: false },
  { keys: ["Shift+drag"], action: "In a timeline track: erase that part of the label (splits a bar)", compact: false },
  { keys: ["drag"], action: "A bar or its edges: move or resize it (snaps to the playhead and other bars' edges)", compact: false },
  { keys: ["Alt"], action: "Held while hovering or dragging on the timeline: no snapping", compact: false },
  { keys: ["dbl-click"], action: "A bar: loop just that part", compact: false },
  { keys: ["wheel"], action: "Over the timeline: zoom (Shift: scroll sideways)", compact: false },
];

/** A chord for display: "<leader> f" shows the leader key itself. */
export function displayChord(chord: string, keymap: Keymap = DEFAULT_KEYMAP): string {
  if (chord.startsWith(LEADER_PREFIX)) {
    return `${keymap.leader} ${chord.slice(LEADER_PREFIX.length)}`;
  }
  return chord;
}

export function keyHelp(keymap: Keymap = DEFAULT_KEYMAP): KeyHelp[] {
  const commands = COMMANDS.map((command) => {
    const chords = keymap.chordsOf.get(command.id);
    let keys: string[] = [];
    if (chords !== undefined) {
      keys = chords.map((chord) => displayChord(chord, keymap));
    }
    return { keys, action: command.title, compact: command.short !== undefined, short: command.short };
  });
  return [...commands, ...POINTER_HELP];
}
