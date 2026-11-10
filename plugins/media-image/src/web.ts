import type { Context } from "@neoworks/extension-system";
import ImagePlayer from "./web/ImagePlayer.svelte";
import ImagePreview from "./web/ImagePreview.svelte";

/** Shows image assets. */
export default {
  name: "media-image-web",
  inject: ["mediaPlayers"],
  apply(ctx: Context) {
    ctx.effect(
      () => ctx.mediaPlayers.register({ id: "image.player", kind: "image", player: ImagePlayer, preview: ImagePreview }),
      "mediaPlayer:image",
    );
  },
};
