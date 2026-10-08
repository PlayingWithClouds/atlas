import type { Span } from "@atlas/contracts";

export const MINIMUM_SPAN_SECONDS = 0.25;

/**
 * The range to cut: the span's stored one, overridden by start/end while a trim is being
 * dragged. Both are clamped to the video, and a degenerate range is widened.
 */
export function resolveClipRange(
  stored: Span,
  override: { start?: number; end?: number },
  duration: number | undefined,
): Span {
  let start = stored.start;
  let end = stored.end;
  if (override.start !== undefined && override.start > 0) {
    start = override.start;
  }
  if (override.end !== undefined && override.end > 0) {
    end = override.end;
  }
  start = Math.max(start, 0);
  if (duration !== undefined && duration > 0 && end > duration) {
    end = duration;
  }
  if (end - start < MINIMUM_SPAN_SECONDS) {
    end = start + MINIMUM_SPAN_SECONDS;
  }
  return { start, end };
}
