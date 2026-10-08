import type { Item, Span } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import type { MediaKind } from "@atlas/contracts/server";
import { IMMUTABLE_CACHE_CONTROL, serveLocalFile, serveWholeVideo } from "./delivery";
import type { WholeVideoDependencies } from "./delivery";
import type { VideoMedia } from "./videoMedia";

export async function serveClip(media: VideoMedia, item: Item, span: Span, request: Request): Promise<Response> {
  const clipPath = await media.ensureClip(item, span);
  if (clipPath === undefined) {
    throw new HttpError(502, "could not cut this clip");
  }
  // The path already encodes the range, so a trimmed span asks for a new file.
  return serveLocalFile(clipPath, request, IMMUTABLE_CACHE_CONTROL);
}

async function servePoster(media: VideoMedia, item: Item, request: Request): Promise<Response> {
  const posterPath = await media.ensurePoster(item);
  if (posterPath === undefined) {
    throw new HttpError(502, "could not decode a frame for this video");
  }
  return serveLocalFile(posterPath, request, IMMUTABLE_CACHE_CONTROL);
}

/** Span items play their cut clip; whole videos stream from the source with Range. */
export function videoMediaKind(media: VideoMedia, delivery: WholeVideoDependencies): MediaKind {
  return {
    id: "video",
    label: "Video",
    serve: (item, request) => {
      if (item.span !== undefined) {
        return serveClip(media, item, item.span, request);
      }
      return serveWholeVideo(delivery, item, request);
    },
    thumbnail: (item, request) => servePoster(media, item, request),
  };
}
