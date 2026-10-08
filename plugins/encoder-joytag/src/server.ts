import path from "node:path";
import type { Context } from "@neoworks/extension-system";
import { registerPythonModel } from "@atlas/server";

interface JoytagConfig {
  device?: "cpu" | "cuda";
}

const PLUGIN_NAME = "encoder-joytag";
const PYTHON_DIRECTORY = path.resolve(import.meta.dir, "../py");

function workerEnvironment(ctx: Context, config: JoytagConfig): Record<string, string> {
  const env: Record<string, string> = {
    ATLAS_PLUGIN_CACHE: ctx.workspace.pluginCacheDirectory(PLUGIN_NAME),
  };
  if (config.device !== undefined) {
    env.ATLAS_DEVICE = config.device;
  }
  return env;
}

export default {
  name: PLUGIN_NAME,
  inject: ["python", "models", "workspace"],
  apply(ctx: Context, config: JoytagConfig = {}) {
    registerPythonModel(ctx, {
      id: "joytag",
      label: "JoyTag (image)",
      module: "atlas_encoder_joytag.encoder",
      paths: [PYTHON_DIRECTORY],
      requirements: [path.join(PYTHON_DIRECTORY, "requirements.txt")],
      env: workerEnvironment(ctx, config),
    });
  },
};
