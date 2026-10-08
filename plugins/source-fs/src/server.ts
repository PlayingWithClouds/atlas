import type { Context } from "@neoworks/extension-system";
import { AllowedRoots } from "./allowedRoots";
import { createFsProvider, defaultVideoRoot } from "./provider";

interface FsSourceConfig {
  /** Folder browsed by the "Local video" kind when the search box is empty. */
  videoRoot?: string;
}

function videoRootOf(config: FsSourceConfig): string {
  if (typeof config.videoRoot === "string" && config.videoRoot !== "") {
    return config.videoRoot;
  }
  return defaultVideoRoot();
}

export default {
  name: "source-fs",
  inject: ["sources", "db"],
  apply(ctx: Context, config: FsSourceConfig = {}) {
    const videoRoot = videoRootOf(config);
    const roots = new AllowedRoots(ctx.db, [videoRoot]);
    ctx.effect(() => ctx.sources.register(createFsProvider(roots, videoRoot)), "source:fs");
  },
};
