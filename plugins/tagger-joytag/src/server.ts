import path from "node:path";
import type { Context } from "@neoworks/extension-system";
import { loadMapping } from "./mapping";
import type { MappingSource } from "./mapping";
import { createJoytagNode } from "./node";

interface TaggerJoytagConfig extends MappingSource {
  device?: "cpu" | "cuda";
  /** Directory holding the JoyTag weights; point it at the encoder-joytag cache to share them. */
  weightsDirectory?: string;
}

const PLUGIN_NAME = "tagger-joytag";
const PYTHON_DIRECTORY = path.resolve(import.meta.dir, "../py");

function workerEnvironment(ctx: Context, config: TaggerJoytagConfig): Record<string, string> {
  const env: Record<string, string> = {
    ATLAS_PLUGIN_CACHE: ctx.workspace.pluginCacheDirectory(PLUGIN_NAME),
  };
  if (config.device !== undefined) {
    env.ATLAS_DEVICE = config.device;
  }
  if (config.weightsDirectory !== undefined && config.weightsDirectory !== "") {
    env.ATLAS_JOYTAG_WEIGHTS = path.resolve(ctx.workspace.directory, config.weightsDirectory);
  }
  return env;
}

export default {
  name: PLUGIN_NAME,
  inject: ["python", "workflows", "workspace", "items", "sources"],
  apply(ctx: Context, config: TaggerJoytagConfig = {}) {
    const mapping = loadMapping(config, ctx.workspace.directory);
    const worker = ctx.python.spawn(ctx, {
      module: "atlas_tagger_joytag.tagger",
      paths: [PYTHON_DIRECTORY],
      requirements: [path.join(PYTHON_DIRECTORY, "requirements.txt")],
      env: workerEnvironment(ctx, config),
    });
    const nodeType = createJoytagNode({ items: ctx.items, sources: ctx.sources, worker, mapping });
    ctx.effect(() => ctx.workflows.registerNode(nodeType), `node:${nodeType.type}`);
  },
};
