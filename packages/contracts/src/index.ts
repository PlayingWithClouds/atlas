/**
 * Shared, domain-agnostic data shapes used by the server, the web app and every plugin.
 *
 * Nothing here knows about any particular media source, encoder or label taxonomy. Concrete
 * behaviour is contributed by plugins through the registries in `./server` and `./web`.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** One annotation on an item. `type` names a primitive registered by a plugin (e.g. "tag"). */
export interface Annotation {
  type: string;
  value: Record<string, unknown>;
}

export type ItemStatus = "pending" | "labeled" | "skipped";

/** A time range inside a longer media resource, in seconds. */
export interface Span {
  start: number;
  end: number;
}

/**
 * A unit of work to label. `ref` identifies the underlying media for the owning source; a span
 * item's ref carries the range as a media fragment (`<ref>#t=<start>,<end>`).
 */
export interface Item {
  id: string;
  sessionId: string;
  index: number;
  ref: string;
  mediaKind: string;
  status: ItemStatus;
  annotations: Annotation[];
  embedded: boolean;
  span?: Span;
  /** Plugin-owned per-item data. `meta.source` overrides the session's source provider for locating. */
  meta: Record<string, unknown>;
}

export interface LabelClass {
  name: string;
  icon?: string;
  info?: string;
  thumbnail?: string;
}

export interface LabelGroup {
  id: string;
  label: string;
  classes: LabelClass[];
}

/** Points at one source plugin's resolvable thing (a folder, a remote collection, ...). */
export interface SourceRef {
  plugin: string;
  kind: string;
  params: Record<string, unknown>;
}

export interface ProjectConfig {
  /** Annotation primitive ids this project uses, e.g. ["tag"]. */
  primitives: string[];
  labels: { groups: LabelGroup[] };
  /** Media kind id the project labels, e.g. "image". Contributed by a media plugin. */
  mediaKind: string;
  /** Model provider id that embeds and classifies this project's items. Required, no default. */
  model: string;
  source?: SourceRef;
  /** Plugin-owned settings, keyed by plugin name. */
  plugins?: Record<string, Record<string, unknown>>;
}

export interface Project {
  id: string;
  name: string;
  config: ProjectConfig;
  created: string;
  updated: string;
}

export interface Session {
  id: string;
  projectId: string;
  label: string;
  source: SourceRef;
  /** True while something is still appending items (extraction, segmentation, ...). */
  producing: boolean;
  created: string;
  /** Plugin-owned per-session state, e.g. a media plugin's resolved stream. */
  meta: Record<string, unknown>;
}

export interface SessionStatus {
  session: Session;
  total: number;
  embedded: number;
  labeled: number;
  skipped: number;
  modelTrained: boolean;
  poolSize: number;
}

/** Compact per-session row for lists and the live `sessions` state slice. */
export interface SessionSummary {
  id: string;
  label: string;
  projectId: string;
  producing: boolean;
  total: number;
  labeled: number;
  skipped: number;
}

export type JobState = "running" | "done" | "error" | "interrupted";

export interface JobView {
  id: string;
  type: string;
  sessionId?: string;
  phase: string;
  done: number;
  total: number;
  state: JobState;
  error: string;
  extra: Record<string, unknown>;
  created: number;
  updated: number;
}

export type NotificationLevel = "info" | "success" | "error";

export interface NotificationView {
  id: string;
  key?: string;
  message: string;
  sessionId?: string;
  level: NotificationLevel;
  created: string;
}

export interface PluginView {
  name: string;
  state: string;
  error?: string;
  /** Labels of what the plugin currently provides or registers, for diagnostics. */
  contributions: string[];
}

// --- workflows ---------------------------------------------------------------------------

export type NodeParamKind = "string" | "text" | "number" | "option" | "boolean";

export interface NodeParam {
  key: string;
  kind: NodeParamKind;
  label: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  help?: string;
}

export type NodePortKind = "none" | "items";

/** Serializable description of a node type, shared with the web designer. */
export interface NodeSpec {
  type: string;
  plugin: string;
  label: string;
  description: string;
  input: NodePortKind;
  output: NodePortKind;
  /** Only items whose fields equal these values enter the node; the rest pass around it. */
  accepts?: Record<string, unknown>;
  /** Fields the node sets on items it returns; used for wiring compatibility hints. */
  emits?: Record<string, unknown>;
  /** Media kinds the node applies to; empty means all. */
  mediaKinds?: string[];
  batch?: number;
  params: NodeParam[];
}

export interface WorkflowNode {
  id: string;
  type: string;
  params?: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface WorkflowEdge {
  source: string;
  target: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface Workflow {
  id: string;
  label: string;
  projectId?: string;
  triggers: string[];
  graph: WorkflowGraph;
}

export interface TriggerSpec {
  id: string;
  plugin: string;
  label: string;
  /** "item" triggers scope a run to the item that fired them. */
  scope: "global" | "session" | "item";
}

export interface GraphReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** What a workflow node sees for each item flowing through the graph. */
export interface WorkItem {
  ref: string;
  status: ItemStatus;
  embedded: boolean;
  annotations: Annotation[];
  span?: Span;
  [field: string]: unknown;
}

// --- plugin manifest ---------------------------------------------------------------------

/** The `atlas` field of a plugin's package.json. */
export interface AtlasPluginManifest {
  /** Module whose default export is the server-side extension-system plugin. */
  server?: string;
  /** Module whose default export is the web-side extension-system plugin. */
  web?: string;
  /** Directory holding the plugin's Python module and requirements.txt. */
  python?: string;
}

/** One entry in a workspace's `atlas.json` plugin list. */
export interface PluginEntry {
  /** Package name; resolved from `path` when given, else from node_modules. */
  package: string;
  path?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface WorkspaceConfig {
  title: string;
  plugins: PluginEntry[];
  workflows: Workflow[];
  /** Free-form settings owned by plugins, keyed by plugin name. */
  settings: Record<string, Record<string, unknown>>;
}

export function spanRef(ref: string, span: Span): string {
  return `${ref}#t=${span.start.toFixed(3)},${span.end.toFixed(3)}`;
}

/** Splits on the last `#t=` so refs that themselves contain fragments survive. */
export function parseSpanRef(spanRefValue: string): { ref: string; span?: Span } {
  const markerIndex = spanRefValue.lastIndexOf("#t=");
  if (markerIndex === -1) {
    return { ref: spanRefValue };
  }
  const range = spanRefValue.slice(markerIndex + 3).split(",");
  if (range.length !== 2) {
    return { ref: spanRefValue };
  }
  const start = Number(range[0]);
  const end = Number(range[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { ref: spanRefValue };
  }
  return { ref: spanRefValue.slice(0, markerIndex), span: { start, end } };
}

export function classNamesOf(config: ProjectConfig): string[] {
  const names: string[] = [];
  for (const group of config.labels.groups) {
    for (const labelClass of group.classes) {
      names.push(labelClass.name);
    }
  }
  return names;
}
