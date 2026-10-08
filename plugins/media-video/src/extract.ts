import type { Context } from "@neoworks/extension-system";
import type { Item, Project, Session, WorkItem } from "@atlas/contracts";
import type { MediaDescriptor, NodeResult, NodeRunContext, NodeType } from "@atlas/contracts/server";
import { FRAMES_SOURCE_ID, framePath } from "./frames";
import {
  EMBED_BATCH_SIZE,
  batchesOf,
  embedDescriptors,
  isWholeVideo,
  numberParam,
  providerOf,
  reportProgress,
  storedItemsOf,
  toWorkItem,
  whileProducing,
} from "./nodeSupport";
import type { VideoMedia } from "./videoMedia";

const DEFAULT_INTERVAL_SECONDS = 20;

function frameItems(ctx: Context, session: Session, framePaths: string[], video: Item, interval: number): Item[] {
  const existingByRef = new Map(ctx.items.list(session.id).map((item) => [item.ref, item]));
  const items: Item[] = [];
  framePaths.forEach((path, frameIndex) => {
    const existing = existingByRef.get(path);
    if (existing !== undefined) {
      items.push(existing);
      return;
    }
    const meta = { source: FRAMES_SOURCE_ID, video: video.ref, timestamp: frameIndex * interval };
    items.push(...ctx.items.append(session.id, [{ ref: path, mediaKind: "image", meta }]));
  });
  return items;
}

async function embedFrames(ctx: Context, project: Project, items: Item[]): Promise<void> {
  const provider = providerOf(ctx, project);
  const pending = items.filter((item) => !item.embedded);
  if (provider === undefined) {
    return;
  }
  for (const batch of batchesOf(pending, EMBED_BATCH_SIZE)) {
    const descriptors: MediaDescriptor[] = batch.map((item) => ({
      ref: item.ref,
      mediaKind: item.mediaKind,
      location: { kind: "file", path: item.ref },
    }));
    const embeddedRefs = new Set(await embedDescriptors(provider, project.id, descriptors));
    ctx.items.setEmbedded(batch.filter((item) => embeddedRefs.has(item.ref)).map((item) => item.id), true);
  }
}

/** Seeks one frame per interval, stopping at the end of the video or at the first failure. */
async function extractFrames(
  media: VideoMedia,
  video: Item,
  directory: string,
  interval: number,
  onFrame: (frameCount: number, total: number) => void,
): Promise<string[]> {
  const duration = await media.durationOf(video);
  const total = duration === undefined ? 0 : Math.floor(duration / interval) + 1;
  const framePaths: string[] = [];
  for (let frameIndex = 0; ; frameIndex++) {
    const seconds = frameIndex * interval;
    if (duration !== undefined && seconds > duration) {
      break;
    }
    const path = framePath(directory, frameIndex);
    if (!(await media.extractFrame(video, seconds, path))) {
      break;
    }
    framePaths.push(path);
    onFrame(framePaths.length, total);
  }
  return framePaths;
}

async function extractFromVideo(
  ctx: Context,
  media: VideoMedia,
  context: NodeRunContext,
  video: Item,
  interval: number,
): Promise<WorkItem[]> {
  const directory = media.caches.framesDirectory(context.session.id, media.videoRefOf(video));
  const progressKey = `ingest:${context.session.id}`;
  const framePaths = await extractFrames(media, video, directory, interval, (frameCount, total) => {
    context.job.progress(frameCount, total);
    reportProgress(ctx, context.session, progressKey, "Extracting frames of", frameCount, total);
  });
  const items = frameItems(ctx, context.session, framePaths, video, interval);
  await embedFrames(ctx, context.project, items);
  return items.map((item) => toWorkItem(ctx.items.get(item.id) as Item));
}

async function runExtract(ctx: Context, media: VideoMedia, items: WorkItem[], context: NodeRunContext): Promise<NodeResult> {
  const interval = Math.max(numberParam(context.params, "interval", DEFAULT_INTERVAL_SECONDS), 0.1);
  const videos = storedItemsOf(ctx, items).filter(isWholeVideo);
  const produced = await whileProducing(ctx, context.session.id, async () => {
    const frames: WorkItem[] = [];
    for (const video of videos) {
      frames.push(...(await extractFromVideo(ctx, media, context, video, interval)));
    }
    return frames;
  });
  return { items: produced, message: `${produced.length} frames from ${videos.length} videos` };
}

export function extractFramesNode(ctx: Context, media: VideoMedia): NodeType {
  return {
    type: "extract-frames",
    plugin: "media-video",
    label: "Extract frames",
    description: "Seeks one still per interval out of each video and adds them as image items.",
    input: "items",
    output: "items",
    accepts: { mediaKind: "video" },
    emits: { mediaKind: "image" },
    mediaKinds: ["image"],
    params: [
      { key: "interval", kind: "number", label: "Interval (s)", default: DEFAULT_INTERVAL_SECONDS, min: 0.1, step: 1 },
    ],
    run: (items, context) => runExtract(ctx, media, items, context),
  };
}
