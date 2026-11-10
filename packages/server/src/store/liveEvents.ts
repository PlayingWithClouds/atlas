import type { Context } from "@neoworks/extension-system";

/** Forwards every store change to connected web clients as a `LiveEvent` message. */
export function LiveEvents(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.store.subscribe((event) => {
        const { type, ...payload } = event;
        ctx.live.broadcast(type, payload);
      }),
    "store:live-events",
  );
}

LiveEvents.inject = ["store", "live"];

export default LiveEvents;
