import type { Context } from "@neoworks/extension-system";
import { describeItems } from "@atlas/server";
import type { Item, Session, WorkItem } from "@atlas/contracts";
import type { MediaLocation, ModelProvider, NodeResult, NodeRunContext, NodeType } from "@atlas/contracts/server";
import { forEachConcurrent } from "../concurrency";
import {
  EMBED_BATCH_SIZE,
  batchesOf,
  embedDescriptors,
  isWholeVideo,
  providerOf,
  reportProgress,
  storedItemsOf,
  toWorkItem,
  whileProducing,
} from "../nodeSupport";
import type { VideoMedia } from "../videoMedia";
import { compareAtoms } from "./similarity";
import { mergeAtoms, planAtoms, planSpans } from "./plan";
import type { SpanPlan } from "./plan";
import { forgetUnusedAtoms, resegment } from "./reconcile";
import { segmentFingerprint, settingsOf } from "./settings";
import type { SegmentSettings } from "./settings";

const POSTER_WORKERS = 6;

interface SegmentPlan {
  spans: SpanPlan[];
  /** Candidate clips scene mode compared to reach `spans`. */
  atoms: SpanPlan[];
  /** Atoms the provider already holds vectors for. */
  embeddedRefs: Set<string>;
  note: string;
}

interface SegmentEnvironment {
  ctx: Context;
  media: VideoMedia;
  context: NodeRunContext;
  provider: ModelProvider | undefined;
}

function fixedPlan(videoRef: string, duration: number, window: number, stride: number, note = ""): SegmentPlan {
  return { spans: planSpans(videoRef, duration, window, stride), atoms: [], embeddedRefs: new Set(), note };
}

/**
 * Decides what to cut. Scene mode degrades to fixed windows when detection cannot run and to
 * unmerged scene cuts when no model can compare them, so the node always produces something
 * and says in `note` when it produced less than asked.
 */
async function planSegments(
  environment: SegmentEnvironment,
  video: Item,
  duration: number,
  location: MediaLocation,
  settings: SegmentSettings,
): Promise<SegmentPlan> {
  const videoRef = environment.media.videoRefOf(video);
  if (settings.mode !== "scenes") {
    return fixedPlan(videoRef, duration, settings.window, settings.stride);
  }
  const { job, project } = environment.context;
  job.phase("detecting scenes");
  const cuts = await environment.media.sceneCuts(video, settings.cutScore);
  if (cuts === undefined) {
    const note = "no scene changes were detected, so clips are fixed windows";
    return fixedPlan(videoRef, duration, settings.window, settings.window, note);
  }
  const atoms = planAtoms(videoRef, duration, cuts, settings.window);
  let comparison = { scores: [] as number[], embeddedRefs: new Set<string>(), note: "" };
  if (settings.merge > 0 && atoms.length >= 2) {
    job.phase("comparing clips");
    comparison = await compareAtoms(environment.provider, project.id, atoms, location, (scored, total) =>
      job.progress(scored, total),
    );
  }
  const spans = mergeAtoms(videoRef, atoms, comparison.scores, settings.merge, settings.minLength, settings.window);
  return { spans, atoms, embeddedRefs: comparison.embeddedRefs, note: comparison.note };
}

async function cutPosters(environment: SegmentEnvironment, clips: Item[]): Promise<void> {
  const { ctx, media, context } = environment;
  context.job.phase("cutting posters");
  let cut = 0;
  await forEachConcurrent(clips, POSTER_WORKERS, async (clip) => {
    // A poster that fails to cut is not fatal: the thumbnail route retries it on demand.
    await media.ensurePoster(clip);
    cut += 1;
    context.job.progress(cut, clips.length);
    reportProgress(ctx, context.session, `segment:${context.session.id}`, "Cutting thumbnails for", cut, clips.length);
  });
}

/** Clips whose ref was compared as an atom already have a vector; they only need the flag. */
function markAlreadyEmbedded(ctx: Context, clips: Item[], embeddedRefs: Set<string>): Item[] {
  const alreadyEmbedded = clips.filter((clip) => embeddedRefs.has(clip.ref));
  ctx.items.setEmbedded(alreadyEmbedded.map((clip) => clip.id), true);
  return clips.filter((clip) => !embeddedRefs.has(clip.ref));
}

/**
 * Embeds the new clips in batches. The batches run one after another on purpose: a provider
 * serializes embeds per project behind a single backbone, so overlapping calls would only queue.
 */
async function embedClips(environment: SegmentEnvironment, clips: Item[], embeddedRefs: Set<string>): Promise<void> {
  const { ctx, context, provider } = environment;
  if (provider === undefined) {
    return;
  }
  const missing = markAlreadyEmbedded(ctx, clips, embeddedRefs);
  context.job.phase("embedding");
  let done = 0;
  for (const batch of batchesOf(missing, EMBED_BATCH_SIZE)) {
    const descriptors = await describeItems(ctx.sources, batch);
    const embeddedBatchRefs = new Set(await embedDescriptors(provider, context.project.id, descriptors));
    ctx.items.setEmbedded(batch.filter((clip) => embeddedBatchRefs.has(clip.ref)).map((clip) => clip.id), true);
    done += batch.length;
    context.job.progress(done, missing.length);
    reportProgress(ctx, context.session, `segment:${context.session.id}`, "Embedding clips of", done, missing.length);
  }
}

function appendClips(ctx: Context, session: Session, videoItem: Item, spans: SpanPlan[]): Item[] {
  const existingRefs = new Set(ctx.items.list(session.id).map((item) => item.ref));
  const fresh = spans.filter((span) => !existingRefs.has(span.ref));
  const newItems = fresh.map((span) => ({
    ref: videoItem.ref,
    mediaKind: "video",
    span: { start: span.start, end: span.end },
  }));
  return ctx.items.append(session.id, newItems);
}

function plannedClips(ctx: Context, sessionId: string, spans: SpanPlan[]): Item[] {
  const byRef = new Map(ctx.items.list(sessionId).map((item) => [item.ref, item]));
  const planned: Item[] = [];
  for (const span of spans) {
    const item = byRef.get(span.ref);
    if (item !== undefined) {
      planned.push(item);
    }
  }
  return planned;
}

/** The whole-video item becomes a container once it has clips; keep it out of the labeling queue. */
function retireContainer(ctx: Context, videoItem: Item): void {
  const current = ctx.items.get(videoItem.id);
  if (current !== undefined && current.status === "pending") {
    ctx.items.setAnnotations(current.id, current.annotations, "skipped");
  }
}

async function finishSegmenting(environment: SegmentEnvironment, plan: SegmentPlan, created: number): Promise<void> {
  const { ctx, context } = environment;
  let message = `Segmented "${context.session.label}" into ${plan.spans.length} clips (${created} new)`;
  if (plan.note !== "") {
    message += `: ${plan.note}`;
  }
  ctx.notifications.persist({ key: `segment:${context.session.id}`, message, sessionId: context.session.id, level: "success" });
  await ctx.labeling.backfill(context.session.id);
}

async function segmentVideo(environment: SegmentEnvironment, video: Item, settings: SegmentSettings): Promise<WorkItem[]> {
  const { ctx, media, context, provider } = environment;
  const duration = await media.durationOf(video);
  if (duration === undefined || settings.window <= 0) {
    ctx.notifications.toast({ message: `Segment skipped: unknown duration of ${video.ref}`, sessionId: context.session.id, level: "error" });
    return [];
  }
  const location = await ctx.sources.locate(video);
  const plan = await planSegments(environment, video, duration, location, settings);
  const videoRef = media.videoRefOf(video);
  await resegment(ctx, provider, context.session, videoRef, segmentFingerprint(settings), plan.spans);
  await forgetUnusedAtoms(provider, context.project.id, plan.atoms, plan.spans);

  const created = appendClips(ctx, context.session, video, plan.spans);
  if (created.length > 0) {
    await cutPosters(environment, created);
  }
  // Includes clips an interrupted earlier run appended but never embedded.
  const unembedded = plannedClips(ctx, context.session.id, plan.spans).filter((clip) => !clip.embedded);
  if (unembedded.length > 0) {
    await embedClips(environment, unembedded, plan.embeddedRefs);
  }
  if (plan.spans.length > 0) {
    retireContainer(ctx, video);
  }
  await finishSegmenting(environment, plan, created.length);
  return plannedClips(ctx, context.session.id, plan.spans).map(toWorkItem);
}

/** Spanned items pass through untouched; whole videos are replaced by their clips. */
async function runSegment(ctx: Context, media: VideoMedia, items: WorkItem[], context: NodeRunContext): Promise<NodeResult> {
  const settings = settingsOf(context.params);
  const environment: SegmentEnvironment = { ctx, media, context, provider: providerOf(ctx, context.project) };
  const stored = storedItemsOf(ctx, items);
  const output = await whileProducing(ctx, context.session.id, async () => {
    const produced: WorkItem[] = [];
    for (const item of stored) {
      if (item.span !== undefined) {
        produced.push(toWorkItem(item));
        continue;
      }
      if (isWholeVideo(item)) {
        produced.push(...(await segmentVideo(environment, item, settings)));
      }
    }
    return produced;
  });
  return { items: output, message: `${output.length} clips` };
}

export function segmentNode(ctx: Context, media: VideoMedia): NodeType {
  return {
    type: "segment",
    plugin: "media-video",
    label: "Segment video",
    description: "Generates temporal clips over each video: fixed windows or detected scenes.",
    input: "items",
    output: "items",
    accepts: { mediaKind: "video" },
    mediaKinds: ["video"],
    params: [
      {
        key: "mode",
        kind: "option",
        label: "Cut at",
        default: "fixed",
        options: [
          { value: "fixed", label: "Fixed windows" },
          { value: "scenes", label: "Detected scenes" },
        ],
      },
      { key: "window", kind: "number", label: "Window (s): fixed length, scenes maximum", default: 4, min: 0.1, step: 0.5 },
      { key: "stride", kind: "number", label: "Stride (s): fixed only", default: 4, min: 0.1, step: 0.5 },
      { key: "minLen", kind: "number", label: "Min length (s): scenes only", default: 2, min: 0.1, step: 0.5 },
      { key: "cutScore", kind: "number", label: "Cut sensitivity: scenes only", default: 0.3, min: 0.05, max: 1, step: 0.05 },
      { key: "merge", kind: "number", label: "Merge similarity: scenes only, 0 = off", default: 0.9, min: 0, max: 1, step: 0.01 },
    ],
    run: (items, context) => runSegment(ctx, media, items, context),
  };
}
