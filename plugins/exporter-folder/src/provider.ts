import fs from "node:fs";
import path from "node:path";
import { HttpError } from "@atlas/contracts/server";
import type { MediaLocation, NewItem, ResolvedSource, SourceProvider } from "@atlas/contracts/server";
import { IMPORT_KIND, PROVIDER_ID, datasetFilePath, readDatasetMediaKind, readLabels } from "./dataset";
import { ImportedRoots } from "./roots";

function directoryParam(params: Record<string, unknown>): string {
  if (typeof params.path !== "string" || params.path.trim() === "") {
    throw new HttpError(400, "path required");
  }
  const directory = path.resolve(params.path.trim());
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new HttpError(404, "dataset folder not found");
  }
  return directory;
}

function mediaKindOf(directory: string, params: Record<string, unknown>): string {
  if (typeof params.mediaKind === "string" && params.mediaKind !== "") {
    return params.mediaKind;
  }
  const recorded = readDatasetMediaKind(directory);
  if (recorded === undefined) {
    throw new HttpError(400, "mediaKind required: the dataset does not record one");
  }
  return recorded;
}

function resolveImport(roots: ImportedRoots, params: Record<string, unknown>): ResolvedSource {
  const directory = directoryParam(params);
  const mediaKind = mediaKindOf(directory, params);
  const labels = readLabels(directory);
  const items: NewItem[] = [];
  for (const fileName of Object.keys(labels).sort()) {
    const filePath = datasetFilePath(directory, fileName);
    if (filePath !== undefined) {
      items.push({ ref: filePath, mediaKind });
    }
  }
  roots.grant(directory);
  return { label: path.basename(directory), items };
}

export function createFolderProvider(roots: ImportedRoots): SourceProvider {
  return {
    id: PROVIDER_ID,
    kinds: () => [
      { id: IMPORT_KIND, label: "Exported dataset", itemNoun: "dataset", browsable: false },
    ],
    resolve: async (kind, params) => {
      if (kind !== IMPORT_KIND) {
        throw new HttpError(400, `unknown kind: ${kind}`);
      }
      return resolveImport(roots, params);
    },
    locate: (ref): MediaLocation => ({ kind: "file", path: roots.authorize(ref) }),
  };
}
