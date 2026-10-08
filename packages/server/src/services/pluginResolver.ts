import fs from "node:fs";
import path from "node:path";
import type { AtlasPluginManifest, PluginEntry } from "@atlas/contracts";

export function resolvePackageDirectory(entry: PluginEntry, workspaceDirectory: string): string {
  if (entry.path !== undefined) {
    return path.resolve(workspaceDirectory, entry.path);
  }
  const manifestPath = Bun.resolveSync(`${entry.package}/package.json`, workspaceDirectory);
  return path.dirname(manifestPath);
}

function readManifest(packageDirectory: string): AtlasPluginManifest {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
  return packageJson.atlas || {};
}

/** Imports the server module declared in the package's `atlas.server` field and returns its default export. */
export async function loadPluginModule(entry: PluginEntry, workspaceDirectory: string): Promise<unknown> {
  const packageDirectory = resolvePackageDirectory(entry, workspaceDirectory);
  const manifest = readManifest(packageDirectory);
  if (!manifest.server) {
    throw new Error(`${entry.package} declares no atlas.server entry`);
  }
  const loaded = await import(path.resolve(packageDirectory, manifest.server));
  if (!loaded.default) {
    throw new Error(`${entry.package} has no default export in ${manifest.server}`);
  }
  return loaded.default;
}
