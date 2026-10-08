import path from "node:path";
import type { Context } from "@neoworks/extension-system";
import { registerPythonModel } from "@atlas/server";

interface SiglipConfig {
  device?: "cpu" | "cuda";
}

const PYTHON_DIRECTORY = path.resolve(import.meta.dir, "../py");

function workerEnvironment(config: SiglipConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.device !== undefined) {
    env.ATLAS_DEVICE = config.device;
  }
  return env;
}

export default {
  name: "encoder-siglip",
  inject: ["python", "models", "workspace"],
  apply(ctx: Context, config: SiglipConfig = {}) {
    registerPythonModel(ctx, {
      id: "siglip",
      label: "SigLIP (image, video, text search)",
      module: "atlas_encoder_siglip.encoder",
      paths: [PYTHON_DIRECTORY],
      requirements: [path.join(PYTHON_DIRECTORY, "requirements.txt")],
      env: workerEnvironment(config),
    });
  },
};
