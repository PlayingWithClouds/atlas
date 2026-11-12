/**
 * What the labeling screen keeps in the browser so nothing typed is lost:
 *
 * - Unsaved drafts per item in localStorage, so a reload (or a closed tab) brings them back.
 * - Each item's undo / redo history in sessionStorage, so moving to another scene and back, or
 *   reloading the tab, keeps it.
 *
 * Both are best effort: a full or missing storage just stores nothing.
 */
import type { Taxonomy } from '@atlas/contracts';
import type { Draft } from './draft';
import { pruneInactive } from './draft';

const DRAFT_PREFIX = 'atlas-draft:';
const HISTORY_PREFIX = 'atlas-history:';
/** Unsaved drafts older than this are dropped. */
const DRAFT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAXIMUM_DRAFTS = 200;
/** Undo steps and items kept per tab; histories hold whole drafts, so they are kept short. */
const STORED_HISTORY_STEPS = 50;
const MAXIMUM_HISTORIES = 30;

export interface StoredDraft {
  draft: Draft;
  /** `updatedAt` of the saved annotation the draft started from; null when there was none. */
  base: string | null;
  /** When it was stored (ms since epoch). */
  savedAt: number;
}

export interface History {
  undo: Draft[];
  redo: Draft[];
}

interface StoredHistory extends History {
  savedAt: number;
}

/** The part of the Web Storage API used here, so tests can pass a plain map. */
export interface KeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class DraftStore {
  constructor(
    private readonly drafts: KeyValueStorage | undefined,
    private readonly histories: KeyValueStorage | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  saveDraft(projectId: string, itemId: string, draft: Draft, base: string | null): void {
    const stored: StoredDraft = { draft, base, savedAt: this.now() };
    writeTrimmed(this.drafts, DRAFT_PREFIX, keyOf(DRAFT_PREFIX, projectId, itemId), stored, MAXIMUM_DRAFTS);
  }

  loadDraft(projectId: string, itemId: string): StoredDraft | undefined {
    const stored = read<StoredDraft>(this.drafts, keyOf(DRAFT_PREFIX, projectId, itemId));
    if (stored === undefined || typeof stored.savedAt !== 'number' || stored.draft === undefined) {
      return undefined;
    }
    if (this.now() - stored.savedAt > DRAFT_LIFETIME_MS) {
      this.clearDraft(projectId, itemId);
      return undefined;
    }
    return stored;
  }

  clearDraft(projectId: string, itemId: string): void {
    remove(this.drafts, keyOf(DRAFT_PREFIX, projectId, itemId));
  }

  saveHistory(projectId: string, itemId: string, history: History): void {
    const stored: StoredHistory = {
      undo: history.undo.slice(-STORED_HISTORY_STEPS),
      redo: history.redo.slice(-STORED_HISTORY_STEPS),
      savedAt: this.now(),
    };
    const key = keyOf(HISTORY_PREFIX, projectId, itemId);
    if (stored.undo.length === 0 && stored.redo.length === 0) {
      remove(this.histories, key);
      return;
    }
    writeTrimmed(this.histories, HISTORY_PREFIX, key, stored, MAXIMUM_HISTORIES);
  }

  loadHistory(projectId: string, itemId: string): History {
    const stored = read<StoredHistory>(this.histories, keyOf(HISTORY_PREFIX, projectId, itemId));
    if (stored === undefined || !Array.isArray(stored.undo) || !Array.isArray(stored.redo)) {
      return { undo: [], redo: [] };
    }
    return { undo: stored.undo, redo: stored.redo };
  }
}

/** The browser's storages, or none outside a browser. */
export function browserDraftStore(): DraftStore {
  if (typeof localStorage === 'undefined' || typeof sessionStorage === 'undefined') {
    return new DraftStore(undefined, undefined);
  }
  return new DraftStore(localStorage, sessionStorage);
}

/**
 * A stored draft fitted to the taxonomy as it is now: groups and labels that were removed since
 * are dropped, as are groups whose condition no longer holds.
 */
export function fitToTaxonomy(taxonomy: Taxonomy, draft: Draft): Draft {
  const known = (groupId: string, labelId: string) =>
    taxonomy.groups.some((group) => group.id === groupId && group.labels.some((label) => label.id === labelId));
  const values: Record<string, string[]> = {};
  for (const [groupId, labelIds] of Object.entries(draft.values)) {
    const kept = labelIds.filter((labelId) => known(groupId, labelId));
    if (kept.length > 0) {
      values[groupId] = kept;
    }
  }
  const fitted: Draft = {
    ...draft,
    values,
    ranges: draft.ranges.filter((range) => known(range.group, range.label)),
    notReviewed: draft.notReviewed.filter((groupId) => taxonomy.groups.some((group) => group.id === groupId)),
  };
  return pruneInactive(taxonomy, fitted);
}

function keyOf(prefix: string, projectId: string, itemId: string): string {
  return `${prefix}${projectId}:${itemId}`;
}

function read<Value>(storage: KeyValueStorage | undefined, key: string): Value | undefined {
  if (storage === undefined) {
    return undefined;
  }
  try {
    const raw = storage.getItem(key);
    if (raw === null) {
      return undefined;
    }
    return JSON.parse(raw) as Value;
  } catch {
    return undefined;
  }
}

function remove(storage: KeyValueStorage | undefined, key: string): void {
  if (storage === undefined) {
    return;
  }
  try {
    storage.removeItem(key);
  } catch {
    // Storage that refuses even removals has nothing of ours to remove.
  }
}

/** Writes `value`, first making room: the oldest entries under `prefix` go beyond `maximum` or when full. */
function writeTrimmed(storage: KeyValueStorage | undefined, prefix: string, key: string, value: { savedAt: number }, maximum: number): void {
  if (storage === undefined) {
    return;
  }
  const text = JSON.stringify(value);
  dropOldest(storage, prefix, key, maximum - 1);
  try {
    storage.setItem(key, text);
  } catch {
    // Full: make more room once, then give up quietly.
    dropOldest(storage, prefix, key, Math.floor(maximum / 2));
    try {
      storage.setItem(key, text);
    } catch {
      return;
    }
  }
}

/** Removes the oldest entries under `prefix` (other than `keep`) until at most `remaining` are left. */
function dropOldest(storage: KeyValueStorage, prefix: string, keep: string, remaining: number): void {
  const entries: { key: string; savedAt: number }[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null || !key.startsWith(prefix) || key === keep) {
      continue;
    }
    entries.push({ key, savedAt: savedAtOf(storage, key) });
  }
  entries.sort((first, second) => first.savedAt - second.savedAt);
  for (const entry of entries.slice(0, Math.max(0, entries.length - remaining))) {
    storage.removeItem(entry.key);
  }
}

function savedAtOf(storage: KeyValueStorage, key: string): number {
  const stored = read<{ savedAt?: unknown }>(storage, key);
  if (stored === undefined || typeof stored.savedAt !== 'number') {
    return 0;
  }
  return stored.savedAt;
}
