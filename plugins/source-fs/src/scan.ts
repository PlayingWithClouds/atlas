import fs from "node:fs";
import path from "node:path";

export const STATE_DIRECTORY_NAME = ".atlas";
export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
export const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v", ".wmv", ".flv", ".ts", ".mpg", ".mpeg",
]);

const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareNatural(left: string, right: string): number {
  return naturalCollator.compare(left, right);
}

function readEntries(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    // Unreadable folders are skipped rather than failing the whole scan.
    return [];
  }
}

function collectFiles(directory: string, extensions: Set<string>, found: string[]): void {
  for (const entry of readEntries(directory)) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== STATE_DIRECTORY_NAME) {
      collectFiles(entryPath, extensions, found);
      continue;
    }
    if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      found.push(entryPath);
    }
  }
}

/** Recursive scan, naturally sorted by full path, skipping `.atlas` state folders. */
export function scanFiles(directory: string, extensions: Set<string>): string[] {
  const found: string[] = [];
  collectFiles(directory, extensions, found);
  return found.sort(compareNatural);
}

export function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch (error) {
    return false;
  }
}

export function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch (error) {
    return false;
  }
}

/** True when `candidate` is `root` itself or lies below it. Both must already be resolved. */
export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === "") {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
