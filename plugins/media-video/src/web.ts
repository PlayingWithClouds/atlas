import type { Context } from "@neoworks/extension-system";
import VideoPlayer from "./web/VideoPlayer.svelte";
import VideoPreview from "./web/VideoPreview.svelte";

/** Plays video assets: progressive files (Range) and HLS, looping the item's span. */
export default {
  name: "media-video-web",
  inject: ["mediaPlayers"],
  apply(ctx: Context) {
    ctx.effect(
      () => ctx.mediaPlayers.register({ id: "video.player", kind: "video", player: VideoPlayer, preview: VideoPreview }),
      "mediaPlayer:video",
    );
  },
};
