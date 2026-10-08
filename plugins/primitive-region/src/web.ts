import type { Context } from "@neoworks/extension-system";
import type { Project } from "@atlas/contracts";
import KeypointToolHint from "./web/KeypointToolHint.svelte";
import PolygonToolHint from "./web/PolygonToolHint.svelte";
import RectToolHint from "./web/RectToolHint.svelte";
import RegionWorkspace from "./web/RegionWorkspace.svelte";

const REGION_PRIMITIVES = ["rect", "polygon", "keypoint"];
const WORKSPACE_PRIORITY = 20;

function usesRegions(project: Project): boolean {
  return project.config.primitives.some((primitive) => REGION_PRIMITIVES.includes(primitive));
}

const TOOLS = [
  { id: "region.rect", primitive: "rect", label: "Bounding box", hotkey: "R", component: RectToolHint },
  { id: "region.polygon", primitive: "polygon", label: "Polygon", hotkey: "P", component: PolygonToolHint },
  { id: "region.keypoint", primitive: "keypoint", label: "Keypoint", hotkey: "K", component: KeypointToolHint },
];

export default {
  name: "primitive-region-web",
  inject: ["gridLabelers", "annotationTools"],
  apply(ctx: Context) {
    ctx.effect(
      () =>
        ctx.gridLabelers.register({
          id: "region.workspace",
          priority: WORKSPACE_PRIORITY,
          matches: usesRegions,
          component: RegionWorkspace,
        }),
      "gridLabeler:region",
    );
    for (const tool of TOOLS) {
      ctx.effect(() => ctx.annotationTools.register(tool), `annotationTool:${tool.primitive}`);
    }
  },
};
