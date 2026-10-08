import os from "node:os";
import path from "node:path";
import { HttpError } from "@atlas/contracts/server";
import type {
  MediaLocation,
  ResolvedSource,
  SourceKind,
  SourceListing,
  SourceProvider,
} from "@atlas/contracts/server";
import { AllowedRoots } from "./allowedRoots";
import { probeDuration } from "./probe";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, isDirectory, isFile, scanFiles } from "./scan";

const DEFAULT_PAGE_SIZE = 40;

const KINDS: SourceKind[] = [
  {
    id: "directory",
    label: "Directory",
    itemNoun: "folder",
    browsable: false,
    ui: { input: "path", hint: "Absolute path to a folder of images" },
  },
  {
    id: "videofile",
    label: "Local video",
    itemNoun: "video",
    browsable: true,
    ui: { input: "path", hint: "Absolute path to a folder of videos" },
  },
];

export function defaultVideoRoot(): string {
  return path.join(process.env.HOME || os.homedir(), "Videos");
}

function pathParam(params: Record<string, unknown>): string {
  if (typeof params.path !== "string" || params.path.trim() === "") {
    throw new HttpError(400, "path required");
  }
  return path.resolve(params.path.trim());
}

function resolveDirectory(roots: AllowedRoots, params: Record<string, unknown>): ResolvedSource {
  const directory = pathParam(params);
  if (!isDirectory(directory)) {
    throw new HttpError(404, "directory not found");
  }
  const images = scanFiles(directory, IMAGE_EXTENSIONS);
  if (images.length === 0 && scanFiles(directory, VIDEO_EXTENSIONS).length > 0) {
    throw new HttpError(400, "folder holds videos, not images; open them under Local video");
  }
  roots.grant(directory);
  return {
    label: path.basename(directory),
    items: images.map((imagePath) => ({ ref: imagePath, mediaKind: "image" })),
  };
}

async function resolveVideoFile(roots: AllowedRoots, params: Record<string, unknown>): Promise<ResolvedSource> {
  const file = pathParam(params);
  if (isDirectory(file)) {
    throw new HttpError(400, "pick a video file, not a folder");
  }
  if (!isFile(file)) {
    throw new HttpError(404, "video not found");
  }
  if (!VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    throw new HttpError(400, `not a video file: ${path.basename(file)}`);
  }
  roots.grant(file);
  const sessionMeta: Record<string, unknown> = {};
  const duration = await probeDuration(file);
  if (duration !== undefined) {
    sessionMeta.duration = duration;
  }
  return {
    label: path.basename(file),
    items: [{ ref: file, mediaKind: "video" }],
    sessionMeta,
  };
}

/** The search box carries a folder path; any other text filters file names. */
function listingScope(search: string, videoRoot: string): { root: string; filter: string } {
  const trimmed = search.trim();
  if (trimmed !== "" && isDirectory(trimmed)) {
    return { root: trimmed, filter: "" };
  }
  return { root: videoRoot, filter: trimmed.toLowerCase() };
}

async function listVideos(
  videoRoot: string,
  query: { search: string; limit: number; offset: number },
): Promise<SourceListing> {
  const { root, filter } = listingScope(query.search, videoRoot);
  if (!isDirectory(root)) {
    return { items: [] };
  }
  let paths = scanFiles(root, VIDEO_EXTENSIONS);
  if (filter !== "") {
    paths = paths.filter((candidate) => path.basename(candidate).toLowerCase().includes(filter));
  }
  const limit = query.limit > 0 ? query.limit : DEFAULT_PAGE_SIZE;
  const page = paths.slice(Math.max(0, query.offset), Math.max(0, query.offset) + limit);
  const items = await Promise.all(page.map((videoPath) => describeVideo(videoPath)));
  return { items };
}

async function describeVideo(videoPath: string): Promise<SourceListing["items"][number]> {
  const meta: Record<string, unknown> = { dir: path.dirname(videoPath) };
  const duration = await probeDuration(videoPath);
  if (duration !== undefined) {
    meta.duration = duration;
  }
  return { id: videoPath, title: path.basename(videoPath), meta };
}

export function createFsProvider(roots: AllowedRoots, videoRoot: string): SourceProvider {
  return {
    id: "fs",
    kinds: () => KINDS,
    list: async (kind, query) => {
      if (kind !== "videofile") {
        throw new HttpError(400, `kind "${kind}" is not browsable`);
      }
      return listVideos(videoRoot, query);
    },
    resolve: async (kind, params) => {
      if (kind === "directory") {
        return resolveDirectory(roots, params);
      }
      if (kind === "videofile") {
        return resolveVideoFile(roots, params);
      }
      throw new HttpError(400, `unknown kind: ${kind}`);
    },
    locate: (ref): MediaLocation => ({ kind: "file", path: roots.authorize(ref) }),
  };
}

