import type { Context } from "@neoworks/extension-system";
import Filmstrip from "./web/Filmstrip.svelte";
import FramePreview from "./web/FramePreview.svelte";
import VideoPlayer from "./web/VideoPlayer.svelte";
import VideoPreview from "./web/VideoPreview.svelte";

/** Plays video assets (progressive files with Range, and HLS) looping the item's span; stills for the timeline. */
export default {
  name: "media-video-web",
  inject: ["mediaPlayers"],
  apply(ctx: Context) {
    const contribution = {
      id: "video.player",
      kind: "video" as const,
      player: VideoPlayer,
      preview: VideoPreview,
      frame: FramePreview,
      filmstrip: Filmstrip,
    };
    ctx.effect(() => ctx.mediaPlayers.register(contribution), "mediaPlayer:video");
  },
};
