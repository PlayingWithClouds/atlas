import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PROJECT_ID } from "./mapping";

const POOL_FILES = ["trainset.npz", "vectors.npz", "meta.json"];
const COPY_SCRIPT = path.join(import.meta.dir, "copyPool.py");

export interface PoolFile {
  name: string;
  bytes: number;
}

export interface PoolPlan {
  projectId: string;
  encoderId: string;
  sourceDirectory: string;
  destinationDirectory: string;
  files: PoolFile[];
}

export interface PoolCopyResult {
  dim: number;
  trainRows: number;
  cacheRows: number;
  rewrittenRefs: number;
  refs: Set<string>;
}

/** Old layout: `<root>/global` for the default project, else `<root>/projects/<id>/pool`; root is namespaced by model id unless it is the generic "model". */
export function oldPoolDirectory(oldCacheDirectory: string, oldModel: string, projectId: string): string {
  let root = oldCacheDirectory;
  if (oldModel !== "model") {
    root = path.join(oldCacheDirectory, oldModel);
  }
  if (projectId === DEFAULT_PROJECT_ID) {
    return path.join(root, "global");
  }
  return path.join(root, "projects", projectId, "pool");
}

function listPoolFiles(directory: string): PoolFile[] {
  const files: PoolFile[] = [];
  for (const name of POOL_FILES) {
    const filePath = path.join(directory, name);
    if (fs.existsSync(filePath)) {
      files.push({ name, bytes: fs.statSync(filePath).size });
    }
  }
  return files;
}

function hasVectors(files: PoolFile[]): boolean {
  return files.some((file) => file.name === "trainset.npz" || file.name === "vectors.npz");
}

export interface PoolSubject {
  projectId: string;
  oldModel: string;
  encoderId: string;
}

/** Only pools that actually hold vectors are planned. */
export function planPool(subject: PoolSubject, oldCacheDirectory: string, targetDirectory: string): PoolPlan | undefined {
  const sourceDirectory = oldPoolDirectory(oldCacheDirectory, subject.oldModel, subject.projectId);
  const files = listPoolFiles(sourceDirectory);
  if (!hasVectors(files)) {
    return undefined;
  }
  return {
    projectId: subject.projectId,
    encoderId: subject.encoderId,
    sourceDirectory,
    destinationDirectory: path.join(targetDirectory, "cache", subject.encoderId, subject.projectId),
    files,
  };
}

export function resolvePython(explicitPath: string | undefined): string {
  if (explicitPath) {
    return explicitPath;
  }
  if (process.env.ATLAS_PYTHON) {
    return process.env.ATLAS_PYTHON;
  }
  const sharedVenv = "/tmp/atlas-ml-venv/bin/python";
  if (fs.existsSync(sharedVenv)) {
    return sharedVenv;
  }
  return "python3";
}

export async function copyPool(plan: PoolPlan, pythonPath: string): Promise<PoolCopyResult> {
  const process_ = Bun.spawn(
    [pythonPath, COPY_SCRIPT, "--source", plan.sourceDirectory, "--destination", plan.destinationDirectory, "--encoder-id", plan.encoderId],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, errorOutput, exitCode] = await Promise.all([
    new Response(process_.stdout).text(),
    new Response(process_.stderr).text(),
    process_.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`pool copy for "${plan.projectId}" failed (${pythonPath}): ${errorOutput.trim()}`);
  }
  const summary = JSON.parse(output);
  return { ...summary, refs: new Set<string>(summary.refs) };
}
