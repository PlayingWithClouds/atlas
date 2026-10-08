import type {} from "@atlas/contracts/web";
import type { Context } from "@neoworks/extension-system";
import DatasetView from "./DatasetView.svelte";

export default {
  name: "exporter-folder",
  inject: ["insightsViews"],
  apply(ctx: Context) {
    ctx.effect(
      () => ctx.insightsViews.register({ id: "exporter-folder:dataset", label: "Dataset", order: 90, component: DatasetView }),
      "insights:dataset",
    );
  },
};
