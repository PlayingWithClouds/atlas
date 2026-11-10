import fs from "node:fs";
import path from "node:path";
import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import type { PluginEntry, WebhookConfig, WorkspaceConfig } from "@atlas/contracts";
import type { WorkspaceService } from "@atlas/contracts/server";

export interface WorkspaceOptions {
  directory: string;
}

const CONFIG_FILE_NAME = "atlas.json";

export function starterConfig(plugins: PluginEntry[] = []): WorkspaceConfig {
  return { title: "atlas", plugins, webhooks: [], tokens: [], settings: {} };
}

/** Creates the workspace directory and a starter atlas.json; an existing file is never touched. */
export function ensureWorkspace(directory: string, plugins: PluginEntry[] = []): void {
  fs.mkdirSync(directory, { recursive: true });
  const configPath = path.join(directory, CONFIG_FILE_NAME);
  if (fs.existsSync(configPath)) {
    return;
  }
  fs.writeFileSync(configPath, JSON.stringify(starterConfig(plugins), null, 2) + "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPluginEntry(value: unknown): value is PluginEntry {
  return isRecord(value) && typeof value.package === "string";
}

function isWebhook(value: unknown): value is WebhookConfig {
  if (!isRecord(value) || typeof value.url !== "string" || !Array.isArray(value.events)) {
    return false;
  }
  return value.project === undefined || typeof value.project === "string";
}

function isToken(value: unknown): value is { name: string; token: string } {
  return isRecord(value) && typeof value.name === "string" && typeof value.token === "string" && value.token !== "";
}

function listOf<T>(value: unknown, accepts: (entry: unknown) => entry is T): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(accepts);
}

function settingsOf(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) {
    return {};
  }
  return value as Record<string, Record<string, unknown>>;
}

function titleOf(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value;
  }
  return fallback;
}

/** Tolerates old and partial files: unknown fields (e.g. `workflows`) are dropped, missing ones defaulted. */
function normalizeConfig(raw: unknown): WorkspaceConfig {
  const starter = starterConfig();
  if (!isRecord(raw)) {
    return starter;
  }
  return {
    title: titleOf(raw.title, starter.title),
    plugins: listOf(raw.plugins, isPluginEntry),
    webhooks: listOf(raw.webhooks, isWebhook),
    tokens: listOf(raw.tokens, isToken),
    settings: settingsOf(raw.settings),
  };
}

export class WorkspaceCore extends Service implements WorkspaceService {
  readonly directory: string;
  readonly cacheDirectory: string;
  private readonly configPath: string;

  constructor(ctx: Context, options: WorkspaceOptions) {
    super(ctx, "workspace");
    this.directory = path.resolve(options.directory);
    this.cacheDirectory = path.join(this.directory, "cache");
    this.configPath = path.join(this.directory, CONFIG_FILE_NAME);
    ensureWorkspace(this.directory);
    fs.mkdirSync(this.cacheDirectory, { recursive: true });
  }

  pluginCacheDirectory(pluginName: string): string {
    const directory = path.join(this.cacheDirectory, pluginName);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  /** Read from disk on every call so hand edits are picked up by the next reload. */
  config(): WorkspaceConfig {
    return normalizeConfig(JSON.parse(fs.readFileSync(this.configPath, "utf8")));
  }

  saveConfig(config: WorkspaceConfig): void {
    const temporaryPath = `${this.configPath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2) + "\n");
    fs.renameSync(temporaryPath, this.configPath);
    this.ctx.emit("workspace/config", config);
  }
}

export default WorkspaceCore;
