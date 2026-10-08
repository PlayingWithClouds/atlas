import type { Context } from "@neoworks/extension-system";
import type { Project } from "@atlas/contracts";
import GridLabeler from "./web/GridLabeler.svelte";
import ItemLabeler from "./web/ItemLabeler.svelte";

const TAG_PRIMITIVE_ID = "tag";
const LABELER_PRIORITY = 10;

function usesTags(project: Project): boolean {
  return project.config.primitives.includes(TAG_PRIMITIVE_ID);
}

export default {
  name: "primitive-tag-web",
  inject: ["gridLabelers", "itemLabelers"],
  apply(ctx: Context) {
    ctx.effect(
      () =>
        ctx.gridLabelers.register({
          id: "tag.grid",
          priority: LABELER_PRIORITY,
          matches: usesTags,
          component: GridLabeler,
        }),
      "gridLabeler:tag",
    );
    ctx.effect(
      () =>
        ctx.itemLabelers.register({
          id: "tag.item",
          priority: LABELER_PRIORITY,
          matches: (project) => usesTags(project),
          component: ItemLabeler,
        }),
      "itemLabeler:tag",
    );
  },
};
