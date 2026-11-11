// Settings shared by every browser on this workspace: key bindings and the numbers behind the
// labeling screen's keys. The server keeps them in atlas.json (settings.web); localStorage caches
// them so the app starts with them at once and keeps working while the server is away. Anything
// missing or broken falls back to its default.
import type { ApiClient } from '@atlas/contracts/web';
import type { LiveState } from '../../kernel/live.svelte';
import type { Bindings, Keymap } from '../labeling/keyboardMap';
import { DEFAULT_LEADER, buildKeymap } from '../labeling/keyboardMap';

const STORAGE_KEY = 'atlas-settings';
const SERVER_PATH = '/settings/web';
/** Edits in quick succession (typing a number) go to the server once. */
const SAVE_DELAY_MS = 400;

/** Where the server copy stands: in step, a save on its way, or unreachable (kept locally). */
export type SyncState = 'synced' | 'saving' | 'offline';

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

function withDefaults(raw: unknown): Settings {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_SETTINGS };
  }
  return { ...DEFAULT_SETTINGS, ...(raw as Partial<Settings>) };
}

function stored(): Settings {
  if (typeof localStorage === 'undefined') {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return { ...DEFAULT_SETTINGS };
    }
    return withDefaults(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

class SettingsState {
  value = $state<Settings>(stored());
  readonly keymap: Keymap = $derived(buildKeymap(this.value.bindings, this.value.leader));
  sync = $state<SyncState>('offline');
  private api: ApiClient | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** A save failed: the local copy is newer, so the next contact pushes instead of pulling. */
  private unsent = false;

  /** Loads the server copy now, and again whenever another browser saves or the socket reconnects. */
  connect(api: ApiClient, live: LiveState): () => void {
    this.api = api;
    void this.pull();
    return live.subscribe((signal) => {
      if (signal.type === 'connected' || (signal.type === 'settings' && signal.scope === 'web')) {
        void this.pull();
      }
    });
  }

  private async pull(): Promise<void> {
    if (this.api === undefined || this.saveTimer !== undefined) {
      return;
    }
    if (this.unsent) {
      await this.push();
      return;
    }
    try {
      const remote = await this.api.get<Record<string, unknown>>(SERVER_PATH);
      if (Object.keys(remote).length === 0) {
        // Nothing shared yet: this browser's settings become the shared ones.
        await this.push();
        return;
      }
      this.value = withDefaults(remote);
      this.cache();
      this.sync = 'synced';
    } catch {
      this.sync = 'offline';
    }
  }

  private async push(): Promise<void> {
    this.saveTimer = undefined;
    if (this.api === undefined) {
      return;
    }
    try {
      await this.api.put(SERVER_PATH, this.value);
      this.unsent = false;
      this.sync = 'synced';
    } catch {
      this.unsent = true;
      this.sync = 'offline';
    }
  }

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
    this.cache();
    if (this.api === undefined) {
      return;
    }
    this.sync = 'saving';
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.push(), SAVE_DELAY_MS);
  }

  private cache(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.value));
  }
}

export const settings = new SettingsState();
