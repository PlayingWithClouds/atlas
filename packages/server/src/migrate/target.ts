import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import type { PluginEntry, Workflow, WorkspaceConfig } from "@atlas/contracts";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../../..");

const ENABLED_PLUGIN_DIRECTORIES = [
  "plugins/core-nodes",
  "plugins/primitive-tag",
  "plugins/media-image",
  "plugins/media-video",
  "plugins/source-fs",
  "plugins/encoder-joytag",
  "plugins/encoder-siglip",
  "plugins/exporter-folder",
];

export function defaultVeilPluginDirectory(): string {
  return path.resolve(REPOSITORY_ROOT, "../veil/packages/atlas-source");
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The migration only ever writes to the target, so it must not overlap anything it reads. */
export function assertTargetIsSeparate(targetDirectory: string, protectedDirectories: string[]): void {
  for (const protectedDirectory of protectedDirectories) {
    const resolved = path.resolve(protectedDirectory);
    if (isInside(targetDirectory, resolved) || isInside(resolved, targetDirectory)) {
      throw new Error(`target ${targetDirectory} overlaps the old data at ${resolved}`);
    }
  }
}

function databasePath(targetDirectory: string): string {
  return path.join(targetDirectory, "atlas.db");
}

/** True when the target database already holds migrated (or any) projects. */
export function targetHasData(targetDirectory: string): boolean {
  const filePath = databasePath(targetDirectory);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const database = new Database(filePath, { readonly: true });
  try {
    const row = database.query("SELECT COUNT(*) AS count FROM projects").get() as { count: number };
    return row.count > 0;
  } catch (error) {
    return false;
  } finally {
    database.close();
  }
}

/** Removes only the target's own database files; never anything outside the target. */
export function resetTargetDatabase(targetDirectory: string): void {
  const filePath = databasePath(targetDirectory);
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(filePath + suffix, { force: true });
  }
}

export function removeTargetPool(destinationDirectory: string): void {
  fs.rmSync(destinationDirectory, { recursive: true, force: true });
}

function readPackageName(pluginDirectory: string): string | undefined {
  const manifestPath = path.join(pluginDirectory, "package.json");
  if (!fs.existsSync(manifestPath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")).name;
}

export function buildPluginEntries(veilDirectory: string, warnings: string[]): PluginEntry[] {
  const directories = ENABLED_PLUGIN_DIRECTORIES.map((relative) => path.join(REPOSITORY_ROOT, relative));
  directories.push(veilDirectory);
  const entries: PluginEntry[] = [];
  for (const directory of directories) {
    const packageName = readPackageName(directory);
    if (packageName === undefined) {
      warnings.push(`plugin directory ${directory} has no package.json; not enabled`);
      continue;
    }
    entries.push({ package: packageName, path: directory, enabled: true });
  }
  return entries;
}

function readExistingConfig(configPath: string): Partial<WorkspaceConfig> {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function mergePlugins(existing: PluginEntry[] | undefined, additions: PluginEntry[]): PluginEntry[] {
  const kept = (existing === undefined ? [] : existing).filter(
    (entry) => !additions.some((addition) => addition.package === entry.package),
  );
  return [...kept, ...additions];
}

/** Written after the database, so the migration host itself never loads these plugins. */
export function writeWorkspaceConfig(
  targetDirectory: string,
  title: string,
  plugins: PluginEntry[],
  workflows: Workflow[],
): void {
  const configPath = path.join(targetDirectory, "atlas.json");
  const existing = readExistingConfig(configPath);
  const config: WorkspaceConfig = {
    title,
    plugins: mergePlugins(existing.plugins, plugins),
    workflows,
    settings: existing.settings === undefined ? {} : existing.settings,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}
