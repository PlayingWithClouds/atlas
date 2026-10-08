import type { Context } from "@neoworks/extension-system";
import FilmReel from "phosphor-svelte/lib/FilmReel";
import Images from "phosphor-svelte/lib/Images";
import Scissors from "phosphor-svelte/lib/Scissors";
import TrimTool from "./web/TrimTool.svelte";
import VideoCell from "./web/VideoCell.svelte";

const TRIM_TOOL_ORDER = 10;

export default {
  name: "media-video-web",
  inject: ["mediaCells", "mediaTools", "projectTemplates", "nodePresentations"],
  apply(ctx: Context) {
    ctx.effect(
      () => ctx.mediaCells.register({ id: "video.cell", mediaKind: "video", component: VideoCell }),
      "mediaCell:video",
    );
    ctx.effect(
      () => ctx.mediaTools.register({ id: "video.trim", mediaKind: "video", order: TRIM_TOOL_ORDER, component: TrimTool }),
      "mediaTool:video-trim",
    );
    // The model is deliberately omitted: the create form requires the user to pick one.
    ctx.effect(
      () =>
        ctx.projectTemplates.register({
          id: "video.clip-tagging",
          label: "Video clip tagging",
          description: "Assign tags to video clips.",
          config: { mediaKind: "video", primitives: ["tag"], labels: { groups: [] } },
        }),
      "projectTemplate:video-clip-tagging",
    );
    registerNodePresentations(ctx);
  },
};

function registerNodePresentations(ctx: Context): void {
  const presentations = [
    { nodeType: "segment", icon: FilmReel },
    { nodeType: "trim", icon: Scissors },
    { nodeType: "extract-frames", icon: Images },
  ];
  for (const presentation of presentations) {
    ctx.effect(
      () => ctx.nodePresentations.register({ id: `video.node.${presentation.nodeType}`, ...presentation }),
      `nodePresentation:${presentation.nodeType}`,
    );
  }
}
