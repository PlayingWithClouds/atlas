import type { BatchResult, LiveEvent } from "@atlas/contracts";
import { ValidationFailure } from "@atlas/contracts/server";
import type { DbService } from "@atlas/contracts/server";
import type { AnnotationsTable } from "./annotationsTable";
import { BatchRecorder, recordLabel, requireBatch } from "./batch";
import type { StoreEvents } from "./events";
import type { MediaTable } from "./mediaTable";
import { isRecord, parseAsset, parseItem, parseSuggestion, spanProblems } from "./parsing";
import type { ProjectsService } from "./projectsService";
import type { SuggestionsTable } from "./suggestionsTable";

export interface MediaTables {
  media: MediaTable;
  annotations: AnnotationsTable;
  suggestions: SuggestionsTable;
}

/** Pushes of assets, items and suggestions, and deletion of items. */
export class MediaService {
  constructor(
    private readonly db: DbService,
    private readonly tables: MediaTables,
    private readonly projects: ProjectsService,
    private readonly events: StoreEvents,
  ) {}

  pushAssets(projectId: string, raw: unknown): BatchResult {
    this.projects.require(projectId);
    const records = requireBatch(raw);
    const recorder = new BatchRecorder();
    this.db.transaction(() => {
      records.forEach((record, index) => this.storeAsset(projectId, record, index, recorder));
    });
    return recorder.result();
  }

  pushItems(projectId: string, raw: unknown): BatchResult {
    this.projects.require(projectId);
    const records = requireBatch(raw);
    const recorder = new BatchRecorder();
    const storedIds: string[] = [];
    this.db.transaction(() => {
      records.forEach((record, index) => this.storeItem(projectId, record, index, recorder, storedIds));
    });
    this.announceItems(projectId, storedIds);
    return recorder.result();
  }

  pushSuggestions(projectId: string, raw: unknown): BatchResult {
    this.projects.require(projectId);
    const records = requireBatch(raw);
    const recorder = new BatchRecorder();
    const storedIds = new Set<string>();
    this.db.transaction(() => {
      records.forEach((record, index) => this.storeSuggestion(projectId, record, index, recorder, storedIds));
    });
    if (storedIds.size > 0) {
      this.events.emit({ type: "suggestions", projectId, ids: [...storedIds] });
    }
    return recorder.result();
  }

  /** Deleting an unknown id succeeds, so adapters can repeat a deletion safely. */
  deleteItems(projectId: string, raw: unknown): BatchResult {
    this.projects.require(projectId);
    const ids = this.readIds(raw);
    const deletedIds: string[] = [];
    const orphanEvents = this.db.transaction(() => ids.flatMap((id) => this.removeItem(projectId, id, deletedIds)));
    this.announceDeletion(projectId, deletedIds, orphanEvents);
    return { ok: ids.length, errors: [] };
  }

  private storeAsset(projectId: string, raw: unknown, index: number, recorder: BatchRecorder): void {
    const parsed = parseAsset(raw);
    if ("problems" in parsed) {
      recorder.reject(recordLabel(raw, index), parsed.problems.join("; "));
      return;
    }
    this.tables.media.upsertAsset(projectId, parsed.value);
    recorder.accept();
  }

  private storeItem(projectId: string, raw: unknown, index: number, recorder: BatchRecorder, storedIds: string[]): void {
    const label = recordLabel(raw, index);
    const parsed = parseItem(raw);
    if ("problems" in parsed) {
      recorder.reject(label, parsed.problems.join("; "));
      return;
    }
    const asset = this.tables.media.getAsset(projectId, parsed.value.assetId);
    if (asset === undefined) {
      recorder.reject(label, `unknown asset "${parsed.value.assetId}"`);
      return;
    }
    const problems = spanProblems(parsed.value, asset);
    if (problems.length > 0) {
      recorder.reject(label, problems.join("; "));
      return;
    }
    this.tables.media.upsertItem(projectId, parsed.value);
    storedIds.push(parsed.value.id);
    recorder.accept();
  }

  private storeSuggestion(
    projectId: string,
    raw: unknown,
    index: number,
    recorder: BatchRecorder,
    storedIds: Set<string>,
  ): void {
    const label = recordLabel(raw, index, "itemId");
    const parsed = parseSuggestion(raw);
    if ("problems" in parsed) {
      recorder.reject(label, parsed.problems.join("; "));
      return;
    }
    if (this.tables.media.getItem(projectId, parsed.value.itemId) === undefined) {
      recorder.reject(label, `unknown item "${parsed.value.itemId}"`);
      return;
    }
    this.tables.suggestions.upsert(projectId, parsed.value);
    storedIds.add(parsed.value.itemId);
    recorder.accept();
  }

  private readIds(raw: unknown): string[] {
    const isValid = isRecord(raw) && Array.isArray(raw.ids) && raw.ids.every((id) => typeof id === "string");
    if (!isValid) {
      throw new ValidationFailure(["the body must be { ids: string[] }"]);
    }
    return requireBatch((raw as { ids: string[] }).ids) as string[];
  }

  /** Returns the "annotation" events for an orphaned annotation, if the item had one. */
  private removeItem(projectId: string, itemId: string, deletedIds: string[]): LiveEvent[] {
    if (!this.tables.media.deleteItem(projectId, itemId)) {
      return [];
    }
    deletedIds.push(itemId);
    this.tables.suggestions.deleteForItem(projectId, itemId);
    const annotation = this.tables.annotations.get(projectId, itemId);
    if (annotation === undefined) {
      return [];
    }
    const change = this.tables.annotations.logChange(projectId, itemId, "orphaned", annotation);
    return [{ type: "annotation", projectId, change }];
  }

  private announceItems(projectId: string, ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    this.events.emit({ type: "items", projectId, ids }, { type: "projects" });
  }

  private announceDeletion(projectId: string, deletedIds: string[], orphanEvents: LiveEvent[]): void {
    if (deletedIds.length === 0) {
      return;
    }
    this.events.emit({ type: "items", projectId, ids: deletedIds }, ...orphanEvents, { type: "projects" });
  }
}
