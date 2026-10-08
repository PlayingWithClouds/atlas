import type { Context } from "@neoworks/extension-system";
import type { MediaKind } from "@atlas/contracts/server";
import { serveLocation } from "./delivery";
import { qualityNode } from "./quality";
import { serveThumbnail } from "./thumbnail";

function imageMediaKind(ctx: Context): MediaKind {
  return {
    id: "image",
    label: "Image",
    serve: async (item, request) => serveLocation(await ctx.sources.locate(item), request),
    thumbnail: (item, request) => serveThumbnail(ctx.sources, item, request),
  };
}

export default {
  name: "media-image",
  inject: ["mediaKinds", "sources", "items"],
  apply(ctx: Context) {
    ctx.effect(() => ctx.mediaKinds.register(imageMediaKind(ctx)), "mediaKind:image");
    // The workflows service is optional; the node appears only while it exists.
    ctx.inject(["workflows"], (workflowsContext) => {
      workflowsContext.effect(() => workflowsContext.workflows.registerNode(qualityNode(ctx)), "node:quality");
    });
  },
};
