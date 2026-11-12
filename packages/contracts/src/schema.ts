/**
 * The atlas data schema (docs/schema.md): taxonomy, media, annotations and suggestions.
 *
 * Atlas stores and shows these; adapters push media and suggestions in over HTTP and read
 * annotations out. Nothing here knows about any particular media source or model.
 */

// --- taxonomy ----------------------------------------------------------------------------

export interface Taxonomy {
  /** Bumped by the server on every change. */
  version: number;
  groups: Group[];
}

export type GroupKind = "single" | "multi";

export interface GroupCondition {
  group: string;
  label: string;
}

export interface Group {
  /** Stable, never reused. */
  id: string;
  label: string;
  kind: GroupKind;
  /** Shown by default; the other groups sit behind "more". */
  primary?: boolean;
  /** Only asked while this label is on. Points at a group without a condition of its own. */
  when?: GroupCondition;
  labels: Label[];
}

export interface Label {
  /** Stable, unique within its group. */
  id: string;
  name: string;
  description?: string;
  /** Example picture URL. */
  image?: string;
  /** One key, unique within the group. */
  hotkey?: string;
  /** Kept for old annotations, no longer offered. */
  deprecated?: boolean;
}

// --- media -------------------------------------------------------------------------------

export type AssetKind = "video" | "image";

export interface Asset {
  /** Chosen by the adapter; pushing the same id again updates the asset. */
  id: string;
  kind: AssetKind;
  /** Loaded by the browser: an http(s) file with Range support, or an HLS playlist. */
  url: string;
  poster?: string;
  /** Seconds, videos only. */
  duration?: number;
  /** Frames per second, videos only; makes single-frame steps exact (measured while playing otherwise). */
  frameRate?: number;
  /**
   * WebVTT thumbnail track for seek previews: cues whose text is an image URL, optionally a sprite
   * tile (`sprite.jpg#xywh=0,0,160,90`), relative to the track. Grabbed from the video otherwise.
   */
  thumbnails?: string;
  width?: number;
  height?: number;
  title?: string;
  /** Adapter-owned, shown read-only. */
  meta?: Record<string, unknown>;
}

export interface Span {
  /** Seconds into the asset. */
  start: number;
  end: number;
}

export interface Item {
  /** Chosen by the adapter; pushing the same id again updates the item. */
  id: string;
  assetId: string;
  /** The whole asset when absent. */
  span?: Span;
  /** Falls back to the asset's poster. */
  poster?: string;
  meta?: Record<string, unknown>;
}

// --- annotations -------------------------------------------------------------------------

export type AnnotationStatus = "labeled" | "skipped";

export interface Range {
  group: string;
  label: string;
  /** Seconds, relative to the item's start. */
  start: number;
  end: number;
}

export interface Annotation {
  itemId: string;
  status: AnnotationStatus;
  /** Group id → label ids that hold for the whole item. */
  values: Record<string, string[]>;
  /** Labels that hold for part of the item only. */
  ranges?: Range[];
  /** Groups the person looked at. A group not listed is unknown, not "none". */
  reviewed: string[];
  /** The person's correction of the item's span; atlas never applies it to the item. */
  span?: Span;
  /** Set by the server on save. */
  taxonomyVersion: number;
  /** Set by the server on save (ISO 8601). */
  updatedAt: string;
}

/** What a client sends to save an annotation; the server fills in the rest. */
export type AnnotationInput = Omit<Annotation, "itemId" | "taxonomyVersion" | "updatedAt">;

// --- suggestions -------------------------------------------------------------------------

export interface Suggestion {
  itemId: string;
  /** e.g. "probe-3"; the latest push per (item, source) replaces the previous one. */
  source: string;
  /** Group id → label id → probability 0..1. */
  values?: Record<string, Record<string, number>>;
  ranges?: (Range & { score: number })[];
  /** Higher = show sooner. */
  priority?: number;
}

// --- projects ----------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  taxonomy: Taxonomy;
  /** Suggestion source used to prefill the labeling screen. */
  prefillSource?: string;
  /**
   * URL the labeling screen asks for suggested ranges at one moment (S):
   * `GET <url>?item=<item id>&at=<item seconds>` → `{ ranges: (Range & { score })[] }`.
   */
  liveSuggestions?: string;
}

export interface ProjectInput {
  id: string;
  name: string;
  taxonomy?: Omit<Taxonomy, "version">;
  prefillSource?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  items: number;
  labeled: number;
  skipped: number;
}

// --- feed --------------------------------------------------------------------------------

export type ChangeKind = "saved" | "deleted" | "orphaned";

export interface Change {
  /** Increases with every change; pass the last one seen as `since`. Opaque to clients. */
  cursor: string;
  itemId: string;
  kind: ChangeKind;
  /** Absent for "deleted". */
  annotation?: Annotation;
}

export interface Feed {
  changes: Change[];
  /** Cursor to pass as `since` next time; equals the input cursor when nothing changed. */
  cursor: string;
}

// --- API shapes --------------------------------------------------------------------------

export interface BatchResult {
  ok: number;
  errors: { id: string; message: string }[];
}

export type ItemStatus = "pending" | AnnotationStatus;

/** An item with what the UI needs to list it. */
export interface ItemView {
  item: Item;
  asset: Asset;
  status: ItemStatus;
  /** Highest priority over all suggestion sources. */
  priority?: number;
  annotation?: Annotation;
  /** In a list filtered by `label` or `unsure`: the model's probability for that label. */
  match?: number;
}

/** Query of `GET /items` and `GET /queue/next` that narrows and orders the items. */
export interface ItemFilterQuery {
  status?: ItemStatus;
  /** Part of the asset title or item id. */
  q?: string;
  /** `group.label`: labeled with it, or (not labeled yet) the model suggests it. */
  label?: string;
  /** `group` or `group.label`: the model is unsure about it. */
  unsure?: string;
  /** order: push order (default); queue: as the queue serves them; match: by `match`. */
  sort?: "order" | "queue" | "match";
}

/** `GET /api/projects/:project/model`: where the model is sure and unsure, over pending items. */
export interface ModelOverview {
  /** Suggestion source the overview and the label filters read; absent without suggestions. */
  source?: string;
  pending: number;
  /** Pending items the model has suggested values for. */
  suggested: number;
  groups: ModelGroupOverview[];
}

export interface ModelGroupOverview {
  group: string;
  /** Pending items with at least one label of the group in the unsure band. */
  unsure: number;
  labels: ModelLabelOverview[];
}

export interface ModelLabelOverview {
  label: string;
  /** Labeled items with this label (whole item or a range). */
  labeled: number;
  /** Pending items the model gives it at least a likely probability. */
  likely: number;
  /** Pending items whose probability for it is inside the unsure band. */
  unsure: number;
}

export interface ItemPage {
  items: ItemView[];
  /** Absent on the last page. */
  cursor?: string;
}

/** `GET /api/projects/:project/items/:item`: everything the labeling screen needs. */
export interface ItemDetail extends ItemView {
  /** Every source's latest push for this item, oldest push first. */
  suggestions: Suggestion[];
  /** Items of the same asset just before and after this one, by span start. */
  previous?: ItemView;
  next?: ItemView;
}

/** Answer of `GET /api/projects/:project/queue/next`. */
export interface QueueNext {
  /** Absent when no pending item is left. */
  item?: ItemView;
  pending: number;
}

// --- live events (server → web over WebSocket) -------------------------------------------

export type LiveEvent =
  | { type: "items"; projectId: string; ids: string[] }
  | { type: "suggestions"; projectId: string; ids: string[] }
  | { type: "annotation"; projectId: string; change: Change }
  | { type: "taxonomy"; projectId: string; taxonomy: Taxonomy }
  | { type: "projects" }
  | { type: "settings"; scope: string };

// --- webhooks (server → adapters) --------------------------------------------------------

export type WebhookEvent =
  | { type: "annotation"; projectId: string; change: Change }
  | { type: "taxonomy"; projectId: string; taxonomy: Taxonomy };

export interface WebhookConfig {
  url: string;
  /** Only this project's events; all projects when absent. */
  project?: string;
  events: WebhookEvent["type"][];
}
