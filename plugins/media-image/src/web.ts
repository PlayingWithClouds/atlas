import type { Context } from "@neoworks/extension-system";
import ImageCell from "./web/ImageCell.svelte";

export default {
  name: "media-image-web",
  inject: ["mediaCells", "projectTemplates"],
  apply(ctx: Context) {
    ctx.effect(
      () => ctx.mediaCells.register({ id: "image.cell", mediaKind: "image", component: ImageCell }),
      "mediaCell:image",
    );
    // The model is deliberately omitted: the create form requires the user to pick one.
    ctx.effect(
      () =>
        ctx.projectTemplates.register({
          id: "image.tagging",
          label: "Image tagging",
          description: "Assign tags to images.",
          config: { mediaKind: "image", primitives: ["tag"], labels: { groups: [] } },
        }),
      "projectTemplate:image-tagging",
    );
  },
};
