import fs from "node:fs";
import path from "node:path";
import { classNamesOf } from "@atlas/contracts";
import type { Item, Project } from "@atlas/contracts";
import type { ItemsService, JobHandle, MediaLocation, SourcesService } from "@atlas/contracts/server";
import { DATASET_FILE, LABELS_FILE, writeJson } from "./dataset";
import type { DatasetLabels } from "./dataset";

export interface ExportServices {
  items: ItemsService;
  sources: SourcesService;
}

export interface ExportSummary {
  exported: number;
  skippedSpans: number;
  skippedFailed: number;
}

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "text/plain": ".txt",
  "application/json": ".json",
};

function extensionFromContentType(contentType: string | null): string {
  if (contentType === null) {
    return "";
  }
  const mimeType = contentType.split(";")[0].trim().toLowerCase();
  return EXTENSION_BY_CONTENT_TYPE[mimeType] ?? "";
}

function extensionFromUrl(url: string): string {
  try {
    return path.extname(new URL(url).pathname).toLowerCase();
  } catch (error) {
    return "";
  }
}

async function copyUrl(location: Extract<MediaLocation, { kind: "url" }>, targetBase: string): Promise<string> {
  const response = await fetch(location.url, { headers: location.headers });
  if (!response.ok) {
    throw new Error(`upstream responded ${response.status}`);
  }
  let extension = extensionFromContentType(response.headers.get("content-type"));
  if (extension === "") {
    extension = extensionFromUrl(location.url);
  }
  if (extension === "") {
    extension = ".bin";
  }
  await Bun.write(`${targetBase}${extension}`, response);
  return extension;
}

/** Writes the item's bytes to `<targetBase><ext>` and returns the extension used. */
async function copyLocation(location: MediaLocation, targetBase: string): Promise<string> {
  if (location.kind === "url") {
    return copyUrl(location, targetBase);
  }
  const extension = path.extname(location.path).toLowerCase();
  fs.copyFileSync(location.path, `${targetBase}${extension}`);
  return extension;
}

function fileNameOf(position: number, extension: string): string {
  return `${String(position).padStart(6, "0")}${extension}`;
}

async function exportItem(services: ExportServices, item: Item, directory: string, position: number): Promise<string> {
  const location = await services.sources.locate(item);
  const targetBase = path.join(directory, String(position).padStart(6, "0"));
  const extension = await copyLocation(location, targetBase);
  return fileNameOf(position, extension);
}

export async function runExport(
  services: ExportServices,
  project: Project,
  directory: string,
  job: JobHandle,
): Promise<ExportSummary> {
  fs.mkdirSync(directory, { recursive: true });
  const labeled = services.items.labeledInProject(project.id);
  job.progress(0, labeled.length);
  job.phase("exporting");

  const labels: DatasetLabels = {};
  const summary: ExportSummary = { exported: 0, skippedSpans: 0, skippedFailed: 0 };
  for (const [index, item] of labeled.entries()) {
    if (job.signal.aborted) {
      throw new Error("export aborted");
    }
    if (item.span !== undefined) {
      summary.skippedSpans += 1;
    } else {
      await exportOne(services, item, directory, labels, summary);
    }
    job.progress(index + 1);
  }

  writeJson(path.join(directory, LABELS_FILE), labels);
  writeJson(path.join(directory, DATASET_FILE), {
    project: { id: project.id, name: project.name, mediaKind: project.config.mediaKind, model: project.config.model },
    classes: classNamesOf(project.config),
    count: summary.exported,
    exported: Math.floor(Date.now() / 1000),
    skipped: summary.skippedSpans + summary.skippedFailed,
    skippedSpans: summary.skippedSpans,
    skippedFailed: summary.skippedFailed,
  });
  return summary;
}

async function exportOne(
  services: ExportServices,
  item: Item,
  directory: string,
  labels: DatasetLabels,
  summary: ExportSummary,
): Promise<void> {
  try {
    const fileName = await exportItem(services, item, directory, summary.exported);
    labels[fileName] = item.annotations;
    summary.exported += 1;
  } catch (error) {
    summary.skippedFailed += 1;
  }
}
