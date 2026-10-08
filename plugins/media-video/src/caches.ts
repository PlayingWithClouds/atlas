import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function sha1Of(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

/**
 * On-disk layout of the plugin's cache directory. Every name is derived from the exact ref
 * (span included), so a trimmed span asks for a new file and renumbering never orphans one.
 */
export class MediaCaches {
  constructor(readonly rootDirectory: string) {}

  get framesRoot(): string {
    return path.join(this.rootDirectory, "frames");
  }

  clipPath(sessionId: string, spanRefValue: string): string {
    return path.join(this.rootDirectory, "clips", sessionId, `${sha1Of(spanRefValue).slice(0, 16)}.mp4`);
  }

  posterPath(sessionId: string, ref: string): string {
    return path.join(this.rootDirectory, "posters", sessionId, `${sha1Of(ref).slice(0, 16)}.jpg`);
  }

  /** Keyed by video rather than session: a re-resolved stream URL must not miss the cache. */
  scenesPath(videoRef: string): string {
    return path.join(this.rootDirectory, "scenes", `${sha1Of(videoRef)}.json`);
  }

  framesDirectory(sessionId: string, videoRef: string): string {
    return path.join(this.framesRoot, sessionId, sha1Of(videoRef).slice(0, 16));
  }

  isInsideFrames(candidate: string): boolean {
    const relative = path.relative(this.framesRoot, path.resolve(candidate));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  removeSession(sessionId: string): void {
    for (const folder of ["clips", "posters", "frames"]) {
      fs.rmSync(path.join(this.rootDirectory, folder, sessionId), { recursive: true, force: true });
    }
  }
}

export function fileHasContent(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > 0;
  } catch (error) {
    return false;
  }
}
