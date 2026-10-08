import { describeItems } from "@atlas/server";
import type { Annotation, WorkItem } from "@atlas/contracts";
import type { ItemsService, NodeResult, NodeRunContext, NodeType, PythonWorker, SourcesService } from "@atlas/contracts/server";
import { classProbabilities, topTags } from "./mapping";
import type { TagMapping } from "./mapping";

export const JOYTAG_THRESHOLD = 0.4;
export const JOYTAG_BATCH = 8;
export const RAW_TAGS_LIMIT = 10;
const TAG_TIMEOUT_MS = 600_000;

export interface JoytagNodeDependencies {
  items: ItemsService;
  sources: SourcesService;
  worker: PythonWorker;
  mapping: TagMapping;
}

type TagScores = Record<string, number>;

function thresholdOf(context: NodeRunContext): number {
  const value = Number(context.params.threshold);
  if (context.params.threshold === undefined || !Number.isFinite(value)) {
    return JOYTAG_THRESHOLD;
  }
  return value;
}

function labelsAbove(probabilities: Record<string, number>, threshold: number): string[] {
  return Object.entries(probabilities)
    .filter(([, probability]) => probability >= threshold)
    .map(([className]) => className);
}

async function scoreItems(dependencies: JoytagNodeDependencies, items: WorkItem[], threshold: number): Promise<TagScores[]> {
  const stored = items.map((item) => dependencies.items.get(String(item.itemId)));
  const present = stored.filter((item) => item !== undefined);
  const descriptors = await describeItems(dependencies.sources, present);
  const scores = await dependencies.worker.call<TagScores[]>("tag", { items: descriptors, minScore: threshold }, { timeoutMs: TAG_TIMEOUT_MS });
  const byRef = new Map(present.map((item, index) => [item.ref, scores[index]]));
  return items.map((item) => byRef.get(item.ref) || {});
}

function projectUsesTags(context: NodeRunContext): boolean {
  return context.project.config.primitives.includes("tag");
}

async function tagItems(dependencies: JoytagNodeDependencies, items: WorkItem[], context: NodeRunContext): Promise<NodeResult> {
  if (!projectUsesTags(context)) {
    return { items, message: "This project has no tag primitive, so JoyTag left the items untouched" };
  }
  const threshold = thresholdOf(context);
  const scores = await scoreItems(dependencies, items, threshold);
  const tagged = items.map((item, index) => {
    const probabilities = classProbabilities(scores[index], dependencies.mapping, context.classes);
    // Always annotate (possibly with no labels) so a following save clears stale proposals.
    const annotation: Annotation = { type: "tag", value: { labels: labelsAbove(probabilities, threshold) } };
    return { ...item, annotations: [annotation], taggerScores: topTags(scores[index], RAW_TAGS_LIMIT) };
  });
  return { items: tagged };
}

export function createJoytagNode(dependencies: JoytagNodeDependencies): NodeType {
  return {
    type: "joytag-tag",
    plugin: "tagger-joytag",
    label: "JoyTag",
    description: "Propose tags with the JoyTag tagger (Danbooru vocabulary mapped to the project's classes)",
    input: "items",
    output: "items",
    accepts: { status: "pending" },
    emits: { annotation: "tag" },
    mediaKinds: ["image"],
    batch: JOYTAG_BATCH,
    params: [{ key: "threshold", kind: "number", label: "Threshold", default: JOYTAG_THRESHOLD, min: 0, max: 1, step: 0.05 }],
    run: (items, context) => tagItems(dependencies, items, context),
  };
}
