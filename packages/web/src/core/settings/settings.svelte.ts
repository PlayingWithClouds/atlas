// Per-browser settings: key bindings and the numbers behind the labeling screen's keys. Kept in
// localStorage like the theme; anything missing or broken in storage falls back to its default.
import type { Bindings, Keymap } from '../labeling/keyboardMap';
import { DEFAULT_LEADER, buildKeymap } from '../labeling/keyboardMap';

const STORAGE_KEY = 'atlas-settings';

export interface Settings {
  /** Chords per labeling command id; commands left out keep their defaults. */
  bindings: Bindings;
  leader: string;
  /** Opens the command menu, anywhere in the app. */
  commandMenu: string;
  seekSeconds: number;
  /** Frames moved by the "several frames" keys. */
  frameJump: number;
  /** Timeline zoom factor per + / - press. */
  zoomStep: number;
  /** "More groups" starts open on every item. */
  expandMoreGroups: boolean;
  /** How long S waits for the adapter's live answer before using the pushed suggestions. */
  liveTimeoutMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  bindings: {},
  leader: DEFAULT_LEADER,
  commandMenu: 'Ctrl+p',
  seekSeconds: 2,
  frameJump: 10,
  zoomStep: 1.6,
  expandMoreGroups: true,
  liveTimeoutMs: 3000
};

function stored(): Settings {
  if (typeof localStorage === 'undefined') {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

class SettingsState {
  value = $state<Settings>(stored());
  readonly keymap: Keymap = $derived(buildKeymap(this.value.bindings, this.value.leader));

  update(change: Partial<Settings>): void {
    this.value = { ...this.value, ...change };
    this.persist();
  }

  bind(commandId: string, chords: string[]): void {
    this.update({ bindings: { ...this.value.bindings, [commandId]: chords } });
  }

  resetBinding(commandId: string): void {
    const bindings = { ...this.value.bindings };
    delete bindings[commandId];
    this.update({ bindings });
  }

  resetAll(): void {
    this.value = { ...DEFAULT_SETTINGS };
    this.persist();
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.value));
  }
}

export const settings = new SettingsState();
