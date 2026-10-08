import fs from "node:fs";
import path from "node:path";

export const SCENE_FLOOR_TIMEOUT_MS = 5 * 60 * 1000;

export interface SceneCutFile {
  threshold: number;
  duration: number;
  cuts: number[];
}

/**
 * Scene detection decodes the whole file, so its deadline scales with the runtime: half the
 * duration, with a floor so short videos still get a workable deadline over a slow connection.
 */
export function sceneTimeoutMs(durationSeconds: number): number {
  const budget = Math.floor(durationSeconds / 2) * 1000;
  return Math.max(budget, SCENE_FLOOR_TIMEOUT_MS);
}

/** The downscale comes first: the score only has to notice that the picture changed. */
export function sceneFilter(threshold: number): string {
  return `scale=w=160:h=-2,select='gt(scene,${threshold.toFixed(3)})',metadata=print:file=-`;
}

/**
 * Reads cut timestamps out of the metadata filter's print output, which pairs a frame line
 * with the score that selected it:
 *
 *   frame:12 pts:98304 pts_time:2.048
 *   lavfi.scene_score=0.412000
 */
export function parseSceneCuts(output: string): number[] {
  const cuts: number[] = [];
  for (const line of output.split("\n")) {
    const match = /pts_time:(\S+)/.exec(line);
    if (match === null) {
      continue;
    }
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds)) {
      cuts.push(seconds);
    }
  }
  return cuts;
}

/** A cached list is only valid for the threshold and duration it was detected with. */
export function readSceneCutFile(filePath: string, threshold: number, duration: number): number[] | undefined {
  let cached: SceneCutFile;
  try {
    cached = JSON.parse(fs.readFileSync(filePath, "utf8")) as SceneCutFile;
  } catch (error) {
    return undefined;
  }
  if (cached.threshold !== threshold || cached.duration !== duration) {
    return undefined;
  }
  if (!Array.isArray(cached.cuts) || cached.cuts.length === 0) {
    return undefined;
  }
  return cached.cuts;
}

export function writeSceneCutFile(filePath: string, cached: SceneCutFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(cached));
}
