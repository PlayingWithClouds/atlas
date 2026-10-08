import fs from "node:fs";
import path from "node:path";
import { HttpError } from "@atlas/contracts/server";
import type { Annotation } from "@atlas/contracts";

export const LABELS_FILE = "labels.json";
export const DATASET_FILE = "dataset.json";
export const PROVIDER_ID = "exporter-folder";
export const IMPORT_KIND = "import";

/** Maps an exported file name to the annotations confirmed on it. */
export type DatasetLabels = Record<string, Annotation[]>;

export function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function isAnnotationList(value: unknown): value is Annotation[] {
  return Array.isArray(value);
}

export function readLabels(directory: string): DatasetLabels {
  const labelsPath = path.join(directory, LABELS_FILE);
  if (!fs.existsSync(labelsPath)) {
    throw new HttpError(404, `${LABELS_FILE} not found in ${directory}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(labelsPath, "utf8"));
  } catch (error) {
    throw new HttpError(400, `${LABELS_FILE} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, `${LABELS_FILE} must map file names to annotation lists`);
  }
  const labels: DatasetLabels = {};
  for (const [fileName, annotations] of Object.entries(parsed)) {
    if (isAnnotationList(annotations)) {
      labels[fileName] = annotations;
    }
  }
  return labels;
}

/** Absolute path of a dataset file, or undefined when the name escapes the folder or is missing. */
export function datasetFilePath(directory: string, fileName: string): string | undefined {
  const filePath = path.resolve(directory, fileName);
  const relative = path.relative(directory, filePath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return undefined;
  }
  return filePath;
}

export function readDatasetMediaKind(directory: string): string | undefined {
  const datasetPath = path.join(directory, DATASET_FILE);
  if (!fs.existsSync(datasetPath)) {
    return undefined;
  }
  try {
    const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
    return dataset.project?.mediaKind;
  } catch (error) {
    return undefined;
  }
}

export function requestedPath(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const value = (body as { path?: unknown }).path;
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return path.resolve(value.trim());
}
