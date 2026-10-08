import { parseSpanRef, spanRef } from "@atlas/contracts";
import type { Annotation, ItemStatus, LabelGroup, ProjectConfig, SourceRef, Span, Workflow, WorkflowNode } from "@atlas/contracts";

/** The old system seeded this project from atlas.config.json instead of storing it. */
export const DEFAULT_PROJECT_ID = "nsfw-tags";

export const DEFAULT_MODEL_MAP: Record<string, string> = { model: "joytag", siglip: "siglip" };

const VEIL_IMAGE_PREFIX = "veil:image:";
const IMAGE_PROXY_PATTERN = /^https?:\/\/[^/]+\/api\/img\?/;

export type JsonRecord = Record<string, unknown>;

export interface OldProject {
  id: string;
  name: string;
  config: JsonRecord;
  created: string;
  updated: string;
}

export interface OldSession {
  id: string;
  project: string;
  source: string;
  ref: string;
  label: string;
  frames_dir: string;
  video: JsonRecord | null;
  producing: boolean;
  created: number;
  segment: string | null;
}

export interface OldImage {
  id: string;
  idx: number;
  ref: string;
  annotations: Annotation[];
  skipped: boolean;
  embedded: boolean;
  status: string;
  t_start?: number | null;
  t_end?: number | null;
}

export interface OldWorkflow {
  id: string;
  label: string;
  project?: string;
  triggers?: string[];
  graph?: {
    nodes?: { id: string; type: string; params?: JsonRecord; pos?: { x: number; y: number } }[];
    edges?: { source: string; target: string }[];
  };
}

export interface NewProjectRow {
  id: string;
  name: string;
  config: ProjectConfig;
  created: string;
  updated: string;
}

export interface MappedSource {
  source: SourceRef;
  /** Set when the old source kind has no counterpart. */
  warning?: string;
}

export interface MappedItemRef {
  ref: string;
  span?: Span;
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Surreal record ids can arrive as `table:key` or `table:⟨key⟩`; the key is what the new schema keeps. */
export function stripRecordPrefix(recordId: string, table: string): string {
  let key = recordId;
  if (key.startsWith(`${table}:`)) {
    key = key.slice(table.length + 1);
  }
  if (key.startsWith("⟨") && key.endsWith("⟩")) {
    key = key.slice(1, -1);
  }
  return key;
}

export function unixSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

// --- models and projects -----------------------------------------------------------------

/** Parses repeated `old=new` pairs layered over the defaults. */
export function parseModelMap(pairs: string[]): Record<string, string> {
  const modelMap = { ...DEFAULT_MODEL_MAP };
  for (const pair of pairs) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === pair.length - 1) {
      throw new Error(`invalid --model-map "${pair}", expected old=new`);
    }
    modelMap[pair.slice(0, separatorIndex)] = pair.slice(separatorIndex + 1);
  }
  return modelMap;
}

/** Old projects without a model used the generic "model" plugin. */
export function oldModelOf(config: JsonRecord): string {
  if (typeof config.model === "string" && config.model !== "") {
    return config.model;
  }
  return "model";
}

export function mapModelId(oldModel: string, modelMap: Record<string, string>): string {
  const mapped = modelMap[oldModel];
  if (mapped === undefined) {
    return oldModel;
  }
  return mapped;
}

function mapMediaKind(config: JsonRecord): string {
  if (config.contentKind === "video") {
    return "video";
  }
  return "image";
}

function mapPrimitives(config: JsonRecord): string[] {
  if (!Array.isArray(config.primitives)) {
    return ["tag"];
  }
  const primitives = config.primitives.filter((entry): entry is string => typeof entry === "string");
  if (primitives.length === 0) {
    return ["tag"];
  }
  return primitives;
}

function mapGroups(config: JsonRecord): LabelGroup[] {
  const labels = config.labels;
  if (!isRecord(labels) || !Array.isArray(labels.groups)) {
    return [];
  }
  return labels.groups as LabelGroup[];
}

function mapProjectSource(config: JsonRecord): SourceRef | undefined {
  const source = config.source;
  if (!isRecord(source) || typeof source.plugin !== "string" || typeof source.kind !== "string") {
    return undefined;
  }
  return source as unknown as SourceRef;
}

export function mapProjectConfig(config: JsonRecord, modelMap: Record<string, string>): ProjectConfig {
  const mapped: ProjectConfig = {
    primitives: mapPrimitives(config),
    labels: { groups: mapGroups(config) },
    mediaKind: mapMediaKind(config),
    model: mapModelId(oldModelOf(config), modelMap),
  };
  const source = mapProjectSource(config);
  if (source !== undefined) {
    mapped.source = source;
  }
  return mapped;
}

export function mapStoredProject(project: OldProject, modelMap: Record<string, string>): NewProjectRow {
  return {
    id: project.id,
    name: project.name,
    config: mapProjectConfig(project.config, modelMap),
    created: project.created,
    updated: project.updated,
  };
}

/** Builds the stored form of the old virtual default project from atlas.config.json. */
export function mapDefaultProject(oldConfig: JsonRecord, modelMap: Record<string, string>, now: string): NewProjectRow {
  let name = DEFAULT_PROJECT_ID;
  if (typeof oldConfig.title === "string" && oldConfig.title !== "") {
    name = oldConfig.title;
  }
  const config = mapProjectConfig({ primitives: oldConfig.primitives, labels: oldConfig.labels }, modelMap);
  return { id: DEFAULT_PROJECT_ID, name, config, created: now, updated: now };
}

// --- sessions ----------------------------------------------------------------------------

export function sessionProjectId(session: OldSession): string {
  if (typeof session.project !== "string" || session.project === "") {
    return DEFAULT_PROJECT_ID;
  }
  return session.project;
}

function idAfterPrefix(ref: string, prefix: string): string {
  if (ref.startsWith(prefix)) {
    return ref.slice(prefix.length);
  }
  return ref;
}

export function mapSessionSource(kind: string, ref: string): MappedSource {
  if (kind === "directory") {
    return { source: { plugin: "fs", kind: "directory", params: { path: ref } } };
  }
  if (kind === "localvideo") {
    return { source: { plugin: "fs", kind: "videofile", params: { path: ref } } };
  }
  if (kind === "gallery") {
    return { source: { plugin: "veil", kind: "gallery", params: { id: idAfterPrefix(ref, "gallery:") } } };
  }
  if (kind === "video" || kind === "scene") {
    return { source: { plugin: "veil", kind: "scene", params: { id: idAfterPrefix(ref, "scene:") } } };
  }
  if (kind === "random") {
    return { source: { plugin: "veil", kind: "random", params: {} } };
  }
  return {
    source: { plugin: "unknown", kind, params: { ref } },
    warning: `session source kind "${kind}" has no counterpart; kept as plugin "unknown"`,
  };
}

export function mapSessionMeta(session: OldSession): JsonRecord {
  const meta: JsonRecord = {};
  if (session.video !== null && session.video !== undefined) {
    meta.video = session.video;
  }
  if (session.frames_dir) {
    meta.framesDir = session.frames_dir;
  }
  if (session.segment) {
    meta.segment = session.segment;
  }
  meta.migratedFrom = "surreal";
  return meta;
}

// --- items -------------------------------------------------------------------------------

/** `http://localhost:8080/api/img?url=<remote>` becomes `veil:image:<remote>`; span fragments survive. */
export function convertImageRef(ref: string): string {
  const parsed = parseSpanRef(ref);
  const base = convertBaseRef(parsed.ref);
  if (parsed.span === undefined) {
    return base;
  }
  return spanRef(base, parsed.span);
}

function convertBaseRef(ref: string): string {
  if (!IMAGE_PROXY_PATTERN.test(ref)) {
    return ref;
  }
  const remoteUrl = new URL(ref).searchParams.get("url");
  if (remoteUrl === null || remoteUrl === "") {
    return ref;
  }
  return `${VEIL_IMAGE_PREFIX}${remoteUrl}`;
}

function spanOf(image: OldImage): Span | undefined {
  if (typeof image.t_start === "number" && typeof image.t_end === "number") {
    return { start: image.t_start, end: image.t_end };
  }
  return parseSpanRef(image.ref).span;
}

/** Returns the base ref and span separately; the item service stores `spanRef(base, span)`. */
export function mapItemRef(image: OldImage): MappedItemRef {
  const span = spanOf(image);
  const base = parseSpanRef(convertImageRef(image.ref)).ref;
  if (span === undefined) {
    return { ref: base };
  }
  return { ref: base, span };
}

export function storedItemRef(mapped: MappedItemRef): string {
  if (mapped.span === undefined) {
    return mapped.ref;
  }
  return spanRef(mapped.ref, mapped.span);
}

/** Old "ai" rows held proposals only, which the new model keeps as annotations on pending items. */
export function mapItemStatus(image: OldImage): ItemStatus {
  if (image.skipped === true || image.status === "skipped") {
    return "skipped";
  }
  if (image.status === "labeled") {
    return "labeled";
  }
  return "pending";
}

/** Frame images extracted from a streamed video are local files, not the session source's refs. */
export function itemMeta(session: OldSession, mapped: MappedItemRef): JsonRecord {
  const isStreamedFrame = session.source === "video" || session.source === "scene";
  if (isStreamedFrame && mapped.ref.startsWith("/")) {
    return { source: "fs" };
  }
  return {};
}

// --- workflows ---------------------------------------------------------------------------

type OldWorkflowNode = { id: string; type: string; params?: JsonRecord; pos?: { x: number; y: number } };

export const JOYTAG_NODE_TYPE = "joytag-tag";

/** Old node types whose new counterpart has a different name; every other type keeps its name. */
const NODE_TYPE_MAP: Record<string, string> = {
  source: "session-items",
  embed: "embed",
  predict: "predict",
  dedupe: "dedupe",
  cluster: "cluster",
  propagate: "propagate",
  "siglip.embed": "embed",
  "siglip.predict": "predict",
  "siglip.dedupe": "dedupe",
  "siglip.cluster": "cluster",
  "siglip.propagate": "propagate",
  segment: "segment",
  quality: "quality",
  trim: "trim",
  extract: "extract-frames",
  "node.tag": JOYTAG_NODE_TYPE,
  joytag: JOYTAG_NODE_TYPE,
};

/** Old model plugins prefixed their nodes (NODE_PREFIX, e.g. "siglip."); the generic nodes carry no encoder name. */
const PREFIXED_MODEL_NODES = ["embed", "predict", "dedupe", "cluster", "propagate"];

export function mapNodeType(oldType: string): string {
  const mapped = NODE_TYPE_MAP[oldType];
  if (mapped !== undefined) {
    return mapped;
  }
  const baseName = oldType.slice(oldType.lastIndexOf(".") + 1);
  if (oldType.includes(".") && PREFIXED_MODEL_NODES.includes(baseName)) {
    return baseName;
  }
  return oldType;
}

function mapNode(node: OldWorkflowNode): WorkflowNode {
  const position = node.pos === undefined ? { x: 0, y: 0 } : node.pos;
  const type = mapNodeType(node.type);
  if (node.params === undefined) {
    return { id: node.id, type, position };
  }
  return { id: node.id, type, params: node.params, position };
}

/** True when any mapped workflow needs the optional JoyTag tagger plugin. */
export function usesJoytagNode(workflows: Workflow[]): boolean {
  return workflows.some((workflow) => workflow.graph.nodes.some((node) => node.type === JOYTAG_NODE_TYPE));
}

function mapTriggers(workflow: OldWorkflow): string[] {
  if (!Array.isArray(workflow.triggers) || workflow.triggers.length === 0) {
    return ["manual"];
  }
  return workflow.triggers;
}

export function mapWorkflow(workflow: OldWorkflow): Workflow {
  const graph = workflow.graph === undefined ? {} : workflow.graph;
  const oldNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const oldEdges = Array.isArray(graph.edges) ? graph.edges : [];
  const mapped: Workflow = {
    id: workflow.id,
    label: workflow.label,
    triggers: mapTriggers(workflow),
    graph: {
      nodes: oldNodes.map(mapNode),
      edges: oldEdges.map((edge) => ({ source: edge.source, target: edge.target })),
    },
  };
  if (workflow.project) {
    mapped.projectId = workflow.project;
  }
  return mapped;
}
