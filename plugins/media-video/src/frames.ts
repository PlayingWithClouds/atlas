import path from "node:path";
import { HttpError } from "@atlas/contracts/server";
import type { SourceProvider } from "@atlas/contracts/server";
import type { MediaCaches } from "./caches";

/** Provider id stored in `meta.source` of the image items that extract-frames appends. */
export const FRAMES_SOURCE_ID = "media-video-frames";

/** Locates extracted stills, and only those: refs outside the frames cache are refused. */
export function framesSourceProvider(caches: MediaCaches): SourceProvider {
  return {
    id: FRAMES_SOURCE_ID,
    kinds: () => [],
    resolve: async () => {
      throw new HttpError(400, "extracted frames are not a browsable source");
    },
    locate: (ref) => {
      if (!caches.isInsideFrames(ref)) {
        throw new HttpError(403, "ref is outside the frames cache");
      }
      return { kind: "file", path: path.resolve(ref) };
    },
  };
}

export function framePath(directory: string, frameIndex: number): string {
  return path.join(directory, `frame_${String(frameIndex).padStart(5, "0")}.jpg`);
}
