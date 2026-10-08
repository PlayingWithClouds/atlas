import type { Context } from "@neoworks/extension-system";
import type { Item } from "@atlas/contracts";

/**
 * Downgrades the session to clip playback when its source ignores byte ranges; the UI then
 * stops asking for the whole file and plays cut clips. Stored as `session.meta.playback`.
 */
export function markClipPlayback(ctx: Context, item: Item): void {
  const session = ctx.items.getSession(item.sessionId);
  if (session === undefined || session.meta.playback === "clip") {
    return;
  }
  ctx.items.updateSession(session.id, { meta: { ...session.meta, playback: "clip" } });
}

/** The duration a source recorded on the session, for when probing the video fails. */
export function sessionDuration(ctx: Context, item: Item): number | undefined {
  const duration = ctx.items.getSession(item.sessionId)?.meta.duration;
  if (typeof duration !== "number" || duration <= 0) {
    return undefined;
  }
  return duration;
}
