/**
 * Server-side service contracts. Each interface below is provided under a key on the
 * extension-system `Context`; plugins `inject` the keys they need.
 *
 * Registries return a disposer from `register(...)`. Call them through `ctx.effect` so the
 * contribution is withdrawn when the registering plugin unloads:
 *
 *   ctx.effect(() => ctx.sources.register(provider))
 */

import type { Database } from "bun:sqlite";
import type {
  Annotation,
  GraphReport,
  Item,
  ItemStatus,
  JobView,
  NodeSpec,
  NotificationLevel,
  NotificationView,
  PluginView,
  Project,
  ProjectConfig,
  Session,
  SessionStatus,
  SessionSummary,
  SourceRef,
  Span,
  TriggerSpec,
  WorkItem,
  Workflow,
  WorkflowGraph,
  WorkspaceConfig,
} from "./index";

export type Dispose = () => void;

// --- infrastructure ----------------------------------------------------------------------

export interface WorkspaceService {
  /** Absolute workspace directory. Holds atlas.json, atlas.db, cache/, exports/. */
  readonly directory: string;
  readonly cacheDirectory: string;
  /** Cache directory reserved for one plugin; created on first call. */
  pluginCacheDirectory(pluginName: string): string;
  config(): WorkspaceConfig;
  /** Persists a modified config atomically (tmp file + rename) and emits `workspace/config`. */
  saveConfig(config: WorkspaceConfig): void;
}

export interface Migration {
  /** Monotonic within its namespace; applied in order, never edited once released. */
  version: number;
  sql: string;
}

export interface DbService {
  readonly database: Database;
  /** Applies pending migrations for a namespace (usually the plugin name). Idempotent. */
  migrate(namespace: string, migrations: Migration[]): void;
  transaction<T>(run: () => T): T;
}

export type RouteParams = Record<string, string>;

/**
 * Returning a plain value serializes it as JSON. Throwing `HttpError` sets the status;
 * any other throw becomes 500 `{detail}`.
 */
export type RouteHandler = (request: Request, params: RouteParams) => unknown | Promise<unknown>;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface HttpService {
  /** `pattern` uses `:name` segments and a trailing `*` wildcard, e.g. `/api/items/:id`. */
  route(method: string, pattern: string, handler: RouteHandler): Dispose;
  readonly port: number;
}

export interface LiveService {
  /** Adds a keyed slice to the `state` snapshot pushed to every client. */
  provideState(key: string, read: () => unknown): Dispose;
  /** Coalesced: schedules a fresh `state` push to every client. */
  notify(): void;
  /** Sends `{type, ...payload}` to every client. */
  broadcast(type: string, payload: Record<string, unknown>): void;
}

export interface JobHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  /** Throttled progress update. */
  progress(done: number, total?: number): void;
  phase(phase: string): void;
  setExtra(extra: Record<string, unknown>): void;
}

export interface JobSpec {
  type: string;
  sessionId?: string;
  total?: number;
  extra?: Record<string, unknown>;
}

export interface JobsService {
  submit(spec: JobSpec, run: (job: JobHandle) => Promise<void>): JobView;
  isRunning(type: string, sessionId?: string): boolean;
  list(filter?: { sessionId?: string; activeOnly?: boolean }): JobView[];
  get(id: string): JobView | undefined;
}

export interface NotificationInput {
  /** Same key replaces the earlier entry, so long-running work keeps one tray line. */
  key?: string;
  message: string;
  sessionId?: string;
  level?: NotificationLevel;
}

export interface NotificationsService {
  persist(input: NotificationInput): NotificationView;
  toast(input: NotificationInput): void;
  list(): NotificationView[];
  dismiss(id: string): void;
  clear(): void;
}

export interface PluginsService {
  list(): PluginView[];
  /** Re-reads atlas.json and loads, unloads or reconfigures plugins to match. */
  reload(): Promise<void>;
}

// --- domain ------------------------------------------------------------------------------

export interface ProjectsService {
  list(): Project[];
  get(projectId: string): Project | undefined;
  create(name: string, config: ProjectConfig): Project;
  update(projectId: string, patch: { name?: string; config?: Partial<ProjectConfig> }): Project;
  remove(projectId: string): void;
}

export interface NewItem {
  ref: string;
  mediaKind: string;
  span?: Span;
  meta?: Record<string, unknown>;
}

export interface ItemsService {
  createSession(input: { projectId: string; label: string; source: SourceRef; meta?: Record<string, unknown> }): Session;
  getSession(sessionId: string): Session | undefined;
  listSessions(projectId?: string): Session[];
  updateSession(sessionId: string, patch: Partial<Pick<Session, "label" | "producing" | "meta">>): Session;
  removeSession(sessionId: string): void;
  /** Async because the model provider is asked for training state. */
  status(sessionId: string): Promise<SessionStatus>;
  summaries(projectId?: string): SessionSummary[];

  /** Appends with idx = max + 1; refs already in the session are skipped. Returns the new items. */
  append(sessionId: string, items: NewItem[]): Item[];
  get(itemId: string): Item | undefined;
  list(sessionId: string, filter?: { status?: ItemStatus; embedded?: boolean }): Item[];
  setAnnotations(itemId: string, annotations: Annotation[], status: ItemStatus): Item;
  /** Stores model-proposed annotations on pending items only. */
  propose(itemId: string, annotations: Annotation[]): Item;
  setEmbedded(itemIds: string[], embedded: boolean): void;
  setSpan(itemId: string, span: Span): Item;
  remove(itemId: string): void;
  /** Labeled items across every session of a project, for training and export. */
  labeledInProject(projectId: string): Item[];
}

// --- media -------------------------------------------------------------------------------

/** How a worker or the browser can read an item's bytes. */
export type MediaLocation =
  | { kind: "file"; path: string }
  | { kind: "url"; url: string; headers?: Record<string, string> };

export interface SourceKind {
  id: string;
  label: string;
  itemNoun: string;
  browsable: boolean;
  /** Free-form hints for the web source picker contributed by the same plugin. */
  ui?: Record<string, unknown>;
}

export interface SourceListing {
  items: { id: string; title: string; thumbnail?: string; meta?: Record<string, unknown> }[];
}

export interface ResolvedSource {
  label: string;
  items: NewItem[];
  /** Merged into the new session's `meta`. */
  sessionMeta?: Record<string, unknown>;
}

export interface SourceProvider {
  /** Unique id; stored in `SourceRef.plugin` and on every item it produced. */
  id: string;
  kinds(): SourceKind[] | Promise<SourceKind[]>;
  list?(kind: string, query: { search: string; limit: number; offset: number }): Promise<SourceListing>;
  resolve(kind: string, params: Record<string, unknown>): Promise<ResolvedSource>;
  /** Where to read a ref's bytes. Every fetch goes through the owning source. */
  locate(ref: string): MediaLocation | Promise<MediaLocation>;
}

export interface SourcesService {
  register(provider: SourceProvider): Dispose;
  get(providerId: string): SourceProvider | undefined;
  list(): SourceProvider[];
  /** Resolves through the provider stored on the item's session. */
  locate(item: Item): Promise<MediaLocation>;
}

export interface MediaKind {
  id: string;
  label: string;
  /** Serves the item to the browser (supports Range where relevant). */
  serve(item: Item, request: Request): Promise<Response>;
  /** Small still preview; falls back to `serve` when absent. */
  thumbnail?(item: Item, request: Request): Promise<Response>;
}

export interface MediaKindsService {
  register(mediaKind: MediaKind): Dispose;
  get(mediaKindId: string): MediaKind | undefined;
  list(): MediaKind[];
}

export interface Primitive {
  id: string;
  label: string;
  /** Returns the cleaned value, or null to drop the annotation (e.g. unknown classes). */
  normalize(value: Record<string, unknown>, project: Project): Record<string, unknown> | null;
  /** Class names an annotation contributes to training, if the primitive is trainable. */
  trainingLabels?(value: Record<string, unknown>): string[];
}

export interface PrimitivesService {
  register(primitive: Primitive): Dispose;
  get(primitiveId: string): Primitive | undefined;
  list(): Primitive[];
}

// --- models ------------------------------------------------------------------------------

/** What a model provider receives to embed an item. */
export interface MediaDescriptor {
  ref: string;
  mediaKind: string;
  location: MediaLocation;
  span?: Span;
}

export interface ModelInsights {
  poolSize: number;
  classes: {
    name: string;
    support: number;
    negatives: number;
    evaluated: boolean;
    averagePrecision?: number;
    f1?: number;
    precision?: number;
    recall?: number;
    threshold?: number;
    baseRate?: number;
  }[];
}

export interface ModelProvider {
  id: string;
  label: string;
  dim: number;
  mediaKinds: string[];
  capabilities: { textSearch: boolean };
  embed(projectId: string, items: MediaDescriptor[]): Promise<{ embedded: string[] }>;
  forget(projectId: string, refs: string[]): Promise<void>;
  train(projectId: string, labeled: { ref: string; labels: string[] }[], classes: string[]): Promise<{ poolSize: number }>;
  predict(projectId: string, refs: string[], classes: string[]): Promise<Record<string, Record<string, number>>>;
  /** Most informative first. Refs without vectors keep their input order at the end. */
  rank(projectId: string, refs: string[], classes: string[], strategy?: string): Promise<{ order: string[]; trained: boolean }>;
  duplicates(projectId: string, refs: string[], threshold: number): Promise<{ keep: string; duplicates: string[] }[]>;
  cluster(projectId: string, refs: string[], threshold: number): Promise<{ keep: string; members: string[] }[]>;
  /** Cosine similarity of each adjacent pair; length is refs.length - 1. */
  similarity(projectId: string, refs: string[]): Promise<number[]>;
  search?(projectId: string, query: string, refs: string[], limit: number): Promise<{ ref: string; score: number }[]>;
  insights(projectId: string, classes: string[]): Promise<ModelInsights>;
  status(projectId: string, classes: string[]): Promise<{ poolSize: number; trained: boolean }>;
  poolDump(projectId: string): Promise<{ ref: string; labels: string[] }[]>;
}

export interface ModelsService {
  register(provider: ModelProvider): Dispose;
  get(providerId: string): ModelProvider | undefined;
  list(): ModelProvider[];
  /** The project's configured provider; throws HttpError(503) when it is not loaded. */
  forProject(project: Project): ModelProvider;
}

export interface LabelingService {
  /** Normalizes through primitives, stores as labeled and trains the project's model. */
  confirm(itemId: string, annotations: Annotation[]): Promise<Item>;
  skip(itemId: string): Item;
  /** Most uncertain pending item, or `waiting` while the session is still producing. */
  next(sessionId: string): Promise<{ item?: Item; done: boolean; waiting: boolean }>;
  suggestions(item: Item): Promise<Record<string, number>>;
  /** Re-trains with every labeled item in a session (after a model change or import). */
  backfill(sessionId: string): Promise<void>;
}

// --- workflows ---------------------------------------------------------------------------

export interface NodeRunContext {
  project: Project;
  session: Session;
  classes: string[];
  params: Record<string, unknown>;
  job: JobHandle;
  /** Items produced by each upstream node, in edge order. */
  inputs: WorkItem[][];
}

export interface NodeResult {
  items: WorkItem[];
  message?: string;
}

export interface NodeType extends NodeSpec {
  run(items: WorkItem[], context: NodeRunContext): Promise<NodeResult>;
}

export interface TriggerEvent {
  trigger: string;
  sessionId?: string;
  itemId?: string;
}

export interface DryRunReport {
  report: GraphReport;
  entities: number;
  nodes: { id: string; type: string; in: number; matched: number; passthrough: number; out: number; note?: string }[];
}

export interface WorkflowsService {
  registerNode(nodeType: NodeType): Dispose;
  registerTrigger(trigger: TriggerSpec): Dispose;
  nodes(projectId?: string): NodeSpec[];
  triggers(): TriggerSpec[];

  list(projectId?: string): Workflow[];
  save(workflow: Workflow): void;
  remove(workflowId: string): void;
  validate(graph: WorkflowGraph, projectId?: string): GraphReport;
  dryRun(sessionId: string, graph: WorkflowGraph): Promise<DryRunReport>;
  /** Submits a `workflow` job; rejects when the same workflow already runs for the session. */
  run(workflowId: string, sessionId: string, itemId?: string): JobView;
  /** Runs every workflow subscribed to the trigger. */
  fire(event: TriggerEvent): void;
}

// --- tools (assistant + MCP) -------------------------------------------------------------

export interface ToolContent {
  type: "text" | "image";
  text?: string;
  /** Base64 data for image blocks. */
  data?: string;
  mimeType?: string;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  inputSchema: Record<string, unknown>;
  /** Tools that confirm labels, train or delete must set this to false. */
  readOnly: boolean;
  run(args: Record<string, unknown>, context: { projectId?: string; sessionId?: string }): Promise<ToolContent[]>;
}

export interface ToolsService {
  register(tool: Tool): Dispose;
  list(): Tool[];
  call(name: string, args: Record<string, unknown>, context: { projectId?: string; sessionId?: string }): Promise<{ content: ToolContent[]; isError: boolean }>;
}

// --- python workers ----------------------------------------------------------------------

export interface PythonWorkerOptions {
  /** Importable module run by `atlas_ml.worker`, e.g. "atlas_encoder_example.encoder". */
  module: string;
  /** Directories added to PYTHONPATH (usually the plugin's `python` dir). */
  paths: string[];
  /** requirements.txt files installed into the shared venv before the first start. */
  requirements: string[];
  env?: Record<string, string>;
}

export interface PythonWorker {
  call<T = unknown>(method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>;
  readonly running: boolean;
}

export interface PythonService {
  /** Spawns the worker inside the caller's effect scope; it is killed when that scope unwinds. */
  spawn(ctx: import("@neoworks/extension-system").Context, options: PythonWorkerOptions): PythonWorker;
}

// --- events ------------------------------------------------------------------------------

declare module "@neoworks/extension-system" {
  interface Context {
    workspace: WorkspaceService;
    db: DbService;
    http: HttpService;
    live: LiveService;
    jobs: JobsService;
    notifications: NotificationsService;
    plugins: PluginsService;
    projects: ProjectsService;
    items: ItemsService;
    sources: SourcesService;
    mediaKinds: MediaKindsService;
    primitives: PrimitivesService;
    models: ModelsService;
    labeling: LabelingService;
    workflows: WorkflowsService;
    tools: ToolsService;
    python: PythonService;
  }

  interface Events {
    "workspace/config"(config: WorkspaceConfig): void;
    "items/changed"(sessionId: string): void;
    "items/labeled"(item: Item): void;
    "session/created"(session: Session): void;
    "session/removed"(sessionId: string): void;
    "project/changed"(project: Project): void;
  }
}
