import fs from "node:fs";
import path from "node:path";
import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import type { WorkspaceConfig } from "@atlas/contracts";
import type { WorkspaceService } from "@atlas/contracts/server";

export interface WorkspaceOptions {
  directory: string;
}

const CONFIG_FILE_NAME = "atlas.json";

export function starterConfig(): WorkspaceConfig {
  return { title: "atlas", plugins: [], workflows: [], settings: {} };
}

/** Creates the workspace directory and a starter atlas.json; an existing file is never touched. */
export function ensureWorkspace(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  const configPath = path.join(directory, CONFIG_FILE_NAME);
  if (fs.existsSync(configPath)) {
    return;
  }
  fs.writeFileSync(configPath, JSON.stringify(starterConfig(), null, 2) + "\n");
}

function normalizeConfig(raw: Partial<WorkspaceConfig>): WorkspaceConfig {
  const starter = starterConfig();
  return {
    title: typeof raw.title === "string" ? raw.title : starter.title,
    plugins: Array.isArray(raw.plugins) ? raw.plugins : starter.plugins,
    workflows: Array.isArray(raw.workflows) ? raw.workflows : starter.workflows,
    settings: raw.settings && typeof raw.settings === "object" ? raw.settings : starter.settings,
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
    const raw = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
    return normalizeConfig(raw);
  }

  saveConfig(config: WorkspaceConfig): void {
    const temporaryPath = `${this.configPath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2) + "\n");
    fs.renameSync(temporaryPath, this.configPath);
    this.ctx.emit("workspace/config", config);
  }
}

export default WorkspaceCore;
