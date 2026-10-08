import type { Context } from "@neoworks/extension-system";
import { createFolderProvider } from "./provider";
import { ImportedRoots } from "./roots";
import { registerRoutes } from "./routes";

export default {
  name: "exporter-folder",
  inject: ["sources", "db", "http", "jobs", "items", "projects", "labeling", "workspace"],
  apply(ctx: Context) {
    const provider = createFolderProvider(new ImportedRoots(ctx.db));
    ctx.effect(() => ctx.sources.register(provider), "source:exporter-folder");
    registerRoutes(ctx, provider);
  },
};
