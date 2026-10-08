import type { Context } from "@neoworks/extension-system";
import type { Item, Span, WorkItem } from "@atlas/contracts";
import type { ModelProvider, NodeResult, NodeRunContext, NodeType } from "@atlas/contracts/server";
import { numberParam, providerOf, storedItemsOf, toWorkItem } from "./nodeSupport";
import { forgetQuietly } from "./segment/reconcile";
import type { VideoMedia } from "./videoMedia";

/** The cut closest to `seconds` within tolerance, or `seconds` unchanged. */
export function nearestCut(seconds: number, cuts: number[], tolerance: number): number {
  let best = seconds;
  let distance = tolerance;
  for (const cut of cuts) {
    const gap = Math.abs(cut - seconds);
    if (gap <= distance) {
      best = cut;
      distance = gap;
    }
  }
  return best;
}

/**
 * Pulls each edge to the nearest cut within tolerance. Edges move independently, and a move
 * that would leave the clip shorter than minLength is refused: a boundary is only worth
 * fixing if what is left is still labelable.
 */
export function snapToCuts(
  span: Span,
  cuts: number[],
  duration: number | undefined,
  tolerance: number,
  minLength: number,
): Span {
  const start = nearestCut(span.start, cuts, tolerance);
  let end = nearestCut(span.end, cuts, tolerance);
  if (duration !== undefined && duration > 0 && end > duration) {
    end = duration;
  }
  if (end - start < minLength) {
    return span;
  }
  return { start, end };
}

interface TrimEnvironment {
  ctx: Context;
  media: VideoMedia;
  context: NodeRunContext;
  provider: ModelProvider | undefined;
  tolerance: number;
  minLength: number;
  cutScore: number;
}

/**
 * Moves one clip's range. Its vector was filed under the old ref, so it is forgotten; a labeled
 * clip is re-confirmed with the same annotations, which embeds the new ref and files the
 * training example under it. Returns undefined when the clip does not move.
 */
async function trimClip(environment: TrimEnvironment, clip: Item, cuts: number[], duration: number | undefined): Promise<Item | undefined> {
  const { ctx, provider, context } = environment;
  const span = clip.span as Span;
  const snapped = snapToCuts(span, cuts, duration, environment.tolerance, environment.minLength);
  if (snapped.start === span.start && snapped.end === span.end) {
    return undefined;
  }
  let moved: Item;
  try {
    moved = ctx.items.setSpan(clip.id, snapped);
  } catch (error) {
    // Another clip already holds that range; the clip keeps its own.
    return undefined;
  }
  await forgetQuietly(provider, context.project.id, [clip.ref]);
  if (clip.status !== "labeled") {
    return moved;
  }
  return ctx.labeling.confirm(clip.id, clip.annotations);
}

async function cutsOf(environment: TrimEnvironment, clip: Item, cache: Map<string, number[] | undefined>): Promise<number[] | undefined> {
  const videoRef = environment.media.videoRefOf(clip);
  if (!cache.has(videoRef)) {
    cache.set(videoRef, await environment.media.sceneCuts(clip, environment.cutScore));
  }
  return cache.get(videoRef);
}

async function runTrim(ctx: Context, media: VideoMedia, items: WorkItem[], context: NodeRunContext): Promise<NodeResult> {
  const environment: TrimEnvironment = {
    ctx,
    media,
    context,
    provider: providerOf(ctx, context.project),
    tolerance: numberParam(context.params, "tolerance", 1),
    minLength: numberParam(context.params, "minLen", 2),
    cutScore: numberParam(context.params, "cutScore", 0.3),
  };
  const cutCache = new Map<string, number[] | undefined>();
  const output: WorkItem[] = [];
  let movedCount = 0;
  const clips = storedItemsOf(ctx, items);
  for (const [position, clip] of clips.entries()) {
    context.job.progress(position, clips.length);
    const cuts = clip.span === undefined ? undefined : await cutsOf(environment, clip, cutCache);
    if (cuts === undefined) {
      output.push(toWorkItem(clip));
      continue;
    }
    const moved = await trimClip(environment, clip, cuts, await media.durationOf(clip));
    if (moved !== undefined) {
      movedCount += 1;
    }
    output.push(toWorkItem(moved === undefined ? clip : moved));
  }
  context.job.progress(clips.length, clips.length);
  return { items: output, message: `${movedCount} of ${clips.length} clips trimmed onto scene cuts` };
}

export function trimNode(ctx: Context, media: VideoMedia): NodeType {
  return {
    type: "trim",
    plugin: "media-video",
    label: "Trim to scenes",
    description: "Snaps clip boundaries onto nearby detected scene cuts.",
    input: "items",
    output: "items",
    accepts: { mediaKind: "video" },
    mediaKinds: ["video"],
    params: [
      { key: "tolerance", kind: "number", label: "Snap within (s)", default: 1, min: 0.1, step: 0.5 },
      { key: "minLen", kind: "number", label: "Min length (s)", default: 2, min: 0.1, step: 0.5 },
      { key: "cutScore", kind: "number", label: "Cut sensitivity", default: 0.3, min: 0.05, max: 1, step: 0.05 },
    ],
    run: (items, context) => runTrim(ctx, media, items, context),
  };
}
