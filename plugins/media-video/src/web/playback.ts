import type { Item, Session } from "@atlas/contracts";

export const MIN_SPAN_SECONDS = 0.25;

/** What a <video> should load and which window of it to loop. `end` is open for whole videos. */
export interface PlaybackPlan {
  src: string;
  start: number;
  end: number | undefined;
}

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  const paddedRest = String(rest).padStart(2, "0");
  if (minutes < 60) {
    return `${minutes}:${paddedRest}`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, "0")}:${paddedRest}`;
}

export function formatRange(start: number, end: number): string {
  return `${formatTime(start)}–${formatTime(end)}`;
}

/** The server downgrades a session to cut clips when its source ignores byte ranges. */
export function sessionPrefersClips(session: Session): boolean {
  return session.meta.playback === "clip";
}

/**
 * Direct playback streams the whole underlying video and loops inside the span. The encoded
 * clip (`/media`) starts at zero, so its window is shifted accordingly.
 */
export function planPlayback(item: Item, session: Session, urlOf: (path: string) => string, forceClip = false): PlaybackPlan {
  const mediaUrl = urlOf(`/items/${item.id}/media`);
  if (item.span === undefined) {
    return { src: mediaUrl, start: 0, end: undefined };
  }
  const length = Math.max(item.span.end - item.span.start, MIN_SPAN_SECONDS);
  if (forceClip || sessionPrefersClips(session)) {
    return { src: mediaUrl, start: 0, end: length };
  }
  return { src: urlOf(`/items/${item.id}/video`), start: item.span.start, end: item.span.end };
}
