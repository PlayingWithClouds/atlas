export type SegmentMode = "fixed" | "scenes";

export interface SegmentSettings {
  mode: SegmentMode;
  /** fixed: clip length; scenes: the longest a merged clip may grow. */
  window: number;
  /** fixed only. */
  stride: number;
  /** scenes only: shorter clips are folded into a neighbour. */
  minLength: number;
  /** scenes only: the scene score a cut has to beat. */
  cutScore: number;
  /** scenes only: cosine at which neighbours are one clip, 0 = off. */
  merge: number;
}

/**
 * The settings that place clip boundaries in this mode, as a string so it compares exactly
 * after a round-trip through the database. Settings the mode ignores are left out: changing
 * the stride in scene mode moves no boundary and must not read as a change.
 */
export function segmentFingerprint(settings: SegmentSettings): string {
  if (settings.mode === "scenes") {
    const { window, minLength, cutScore, merge } = settings;
    return `scenes|window=${window.toFixed(3)}|min=${minLength.toFixed(3)}|cut=${cutScore.toFixed(3)}|merge=${merge.toFixed(3)}`;
  }
  return `fixed|window=${settings.window.toFixed(3)}|stride=${settings.stride.toFixed(3)}`;
}

function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const raw = params[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return raw;
}

export function settingsOf(params: Record<string, unknown>): SegmentSettings {
  const mode: SegmentMode = params.mode === "scenes" ? "scenes" : "fixed";
  return {
    mode,
    window: numberParam(params, "window", 4),
    stride: numberParam(params, "stride", 4),
    minLength: numberParam(params, "minLen", 2),
    cutScore: numberParam(params, "cutScore", 0.3),
    merge: numberParam(params, "merge", 0.9),
  };
}
