import type { Context } from "@neoworks/extension-system";
import { MediaCaches } from "./caches";
import type { WholeVideoDependencies } from "./delivery";
import { FfmpegTools } from "./ffmpeg";
import { extractFramesNode } from "./extract";
import { framesSourceProvider } from "./frames";
import { videoMediaKind } from "./mediaKind";
import { markClipPlayback, sessionDuration } from "./playback";
import { registerVideoRoutes } from "./routes";
import { segmentNode } from "./segment/node";
import { SheetRenderer, contactSheetTool } from "./sheet";
import { trimNode } from "./trim";
import { VideoMedia } from "./videoMedia";

export default {
  name: "media-video",
  inject: ["mediaKinds", "sources", "items", "http", "workspace", "notifications", "models", "labeling"],
  apply(ctx: Context) {
    const tools = new FfmpegTools((message) => ctx.logger("media-video").warn(message));
    ctx.effect(() => () => tools.stop(), "ffmpeg:processes");
    const caches = new MediaCaches(ctx.workspace.pluginCacheDirectory("media-video"));
    const media = new VideoMedia({
      tools,
      caches,
      locate: (item) => ctx.sources.locate(item),
      fallbackDuration: (item) => sessionDuration(ctx, item),
    });
    const delivery: WholeVideoDependencies = { locate: (item) => ctx.sources.locate(item), onRangesIgnored: (item) => markClipPlayback(ctx, item) };
    const sheet = new SheetRenderer(ctx, media, tools);

    ctx.effect(() => ctx.mediaKinds.register(videoMediaKind(media, delivery)), "mediaKind:video");
    ctx.effect(() => ctx.sources.register(framesSourceProvider(caches)), "source:media-video-frames");
    registerVideoRoutes(ctx, media, delivery, sheet);
    ctx.on("session/removed", (sessionId) => caches.removeSession(sessionId));

    // Both services are optional; their contributions appear only while they exist.
    ctx.inject(["workflows"], (workflowsContext) => {
      workflowsContext.effect(() => workflowsContext.workflows.registerNode(extractFramesNode(ctx, media)), "node:extract-frames");
      workflowsContext.effect(() => workflowsContext.workflows.registerNode(segmentNode(ctx, media)), "node:segment");
      workflowsContext.effect(() => workflowsContext.workflows.registerNode(trimNode(ctx, media)), "node:trim");
    });
    ctx.inject(["tools"], (toolsContext) => {
      toolsContext.effect(() => toolsContext.tools.register(contactSheetTool(sheet)), "tool:contact_sheet");
    });
  },
};
