import fs from "node:fs";
import path from "node:path";
import type { AtlasPluginManifest, PluginEntry } from "@atlas/contracts";

/** The plugin's package is not on disk or not installed; older workspaces list plugins that no longer exist. */
export class PluginNotFoundError extends Error {}

export function resolvePackageDirectory(entry: PluginEntry, workspaceDirectory: string): string {
  if (entry.path !== undefined) {
    return resolveDeclaredPath(entry, workspaceDirectory);
  }
  try {
    const manifestPath = Bun.resolveSync(`${entry.package}/package.json`, workspaceDirectory);
    return path.dirname(manifestPath);
  } catch {
    throw new PluginNotFoundError(`package ${entry.package} is not installed`);
  }
}

function resolveDeclaredPath(entry: PluginEntry, workspaceDirectory: string): string {
  const directory = path.resolve(workspaceDirectory, entry.path as string);
  if (!fs.existsSync(path.join(directory, "package.json"))) {
    throw new PluginNotFoundError(`${entry.package} has no package.json at ${directory}`);
  }
  return directory;
}

function readManifest(packageDirectory: string): AtlasPluginManifest {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
  if (packageJson.atlas === undefined) {
    return {};
  }
  return packageJson.atlas;
}

/**
 * Imports the server module declared in the package's `atlas.server` field and returns its
 * default export. Undefined when the package has no server part (web-only plugins).
 */
export async function loadPluginModule(entry: PluginEntry, workspaceDirectory: string): Promise<unknown> {
  const packageDirectory = resolvePackageDirectory(entry, workspaceDirectory);
  const manifest = readManifest(packageDirectory);
  if (!manifest.server) {
    return undefined;
  }
  const loaded = await import(path.resolve(packageDirectory, manifest.server));
  if (!loaded.default) {
    throw new Error(`${entry.package} has no default export in ${manifest.server}`);
  }
  return loaded.default;
}
