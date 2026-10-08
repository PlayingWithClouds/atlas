import { FiberState, Service } from "@neoworks/extension-system";
import type { Context, EffectMeta, Fiber } from "@neoworks/extension-system";
import type { PluginEntry, PluginView } from "@atlas/contracts";
import type { PluginsService } from "@atlas/contracts/server";
import { loadPluginModule } from "./pluginResolver";

interface LoadedPlugin {
  entry: PluginEntry;
  configKey: string;
  fiber?: Fiber;
  loadError?: string;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function configKeyOf(entry: PluginEntry): string {
  return JSON.stringify(sortKeys(entry.config === undefined ? {} : entry.config));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function fiberErrorMessage(fiber: Fiber): string | undefined {
  const failure = (fiber as unknown as { _error?: unknown })._error;
  if (failure === undefined) {
    return undefined;
  }
  return errorMessage(failure);
}

function collectLabels(effects: EffectMeta[], labels: string[]): void {
  for (const effect of effects) {
    if (effect.label) {
      labels.push(effect.label);
    }
    collectLabels(effect.children, labels);
  }
}

function contributionsOf(fiber: Fiber): string[] {
  const labels: string[] = [];
  collectLabels(fiber.getEffects(), labels);
  return labels;
}

export class PluginsCore extends Service implements PluginsService {
  static inject = ["workspace", "http", "live"];

  private readonly loaded = new Map<string, LoadedPlugin>();
  private reloadQueue: Promise<void> = Promise.resolve();

  constructor(ctx: Context) {
    super(ctx, "plugins");
    this.ctx.effect(() => this.ctx.live.provideState("plugins", () => this.list()), "plugins:state");
    this.ctx.on("workspace/config", () => this.reloadQuietly());
    this.ctx.effect(() => () => this.loaded.clear(), "plugins:registry");
    this.registerRoutes();
  }

  list(): PluginView[] {
    const views: PluginView[] = [];
    for (const [name, plugin] of this.loaded) {
      views.push(this.viewOf(name, plugin));
    }
    return views;
  }

  reload(): Promise<void> {
    const run = this.reloadQueue.then(() => this.applyConfig());
    this.reloadQueue = run.catch(() => {});
    return run;
  }

  private viewOf(name: string, plugin: LoadedPlugin): PluginView {
    if (!plugin.fiber) {
      return { name, state: FiberState[FiberState.FAILED], error: plugin.loadError, contributions: [] };
    }
    return {
      name,
      state: FiberState[plugin.fiber.state],
      error: fiberErrorMessage(plugin.fiber),
      contributions: contributionsOf(plugin.fiber),
    };
  }

  private reloadQuietly(): void {
    this.reload().catch((error) => this.ctx.logger.error(error));
  }

  private async applyConfig(): Promise<void> {
    const entries = this.ctx.workspace
      .config()
      .plugins.filter((entry) => entry.enabled !== false);
    const wanted = new Map(entries.map((entry) => [entry.package, entry]));
    await this.removeUnwanted(wanted);
    for (const entry of wanted.values()) {
      await this.syncEntry(entry);
    }
    this.ctx.live.notify();
  }

  private async removeUnwanted(wanted: Map<string, PluginEntry>): Promise<void> {
    for (const [name, plugin] of [...this.loaded]) {
      const entry = wanted.get(name);
      if (entry && entry.path === plugin.entry.path) {
        continue;
      }
      await this.unload(name);
    }
  }

  private async unload(name: string): Promise<void> {
    const plugin = this.loaded.get(name);
    this.loaded.delete(name);
    if (plugin && plugin.fiber) {
      await plugin.fiber.dispose();
    }
  }

  private async syncEntry(entry: PluginEntry): Promise<void> {
    const existing = this.loaded.get(entry.package);
    if (!existing || !existing.fiber) {
      await this.load(entry);
      return;
    }
    await this.updateConfig(existing, entry);
  }

  private async load(entry: PluginEntry): Promise<void> {
    const plugin: LoadedPlugin = { entry, configKey: configKeyOf(entry) };
    this.loaded.set(entry.package, plugin);
    try {
      const module = await loadPluginModule(entry, this.ctx.workspace.directory);
      plugin.fiber = this.ctx.plugin(module as never, entry.config as never);
      await plugin.fiber.await();
    } catch (error) {
      this.ctx.logger.error(error);
      this.recordLoadFailure(plugin, error);
    }
  }

  private recordLoadFailure(plugin: LoadedPlugin, error: unknown): void {
    if (!plugin.fiber) {
      plugin.loadError = errorMessage(error);
    }
  }

  private async updateConfig(plugin: LoadedPlugin, entry: PluginEntry): Promise<void> {
    const configKey = configKeyOf(entry);
    if (configKey === plugin.configKey || !plugin.fiber) {
      return;
    }
    plugin.entry = entry;
    plugin.configKey = configKey;
    try {
      plugin.fiber.update(entry.config);
      await plugin.fiber.await();
    } catch (error) {
      this.ctx.logger.error(error);
    }
  }

  private registerRoutes(): void {
    this.ctx.effect(() => this.ctx.http.route("GET", "/api/plugins", () => this.list()), "route:GET /api/plugins");
    this.ctx.effect(() => this.ctx.http.route("POST", "/api/plugins/reload", async () => {
      await this.reload();
      return this.list();
    }), "route:POST /api/plugins/reload");
  }
}

export default PluginsCore;
