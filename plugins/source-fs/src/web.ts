import type { Context } from "@neoworks/extension-system";
import DirectoryPicker from "./web/DirectoryPicker.svelte";
import VideoFilePicker from "./web/VideoFilePicker.svelte";

export default {
  name: "source-fs-web",
  inject: ["sourcePickers"],
  apply(ctx: Context) {
    ctx.effect(
      () => ctx.sourcePickers.register({ id: "fs.directory", sourceKind: "fs:directory", component: DirectoryPicker }),
      "sourcePicker:fs:directory",
    );
    ctx.effect(
      () => ctx.sourcePickers.register({ id: "fs.videofile", sourceKind: "fs:videofile", component: VideoFilePicker }),
      "sourcePicker:fs:videofile",
    );
  },
};
