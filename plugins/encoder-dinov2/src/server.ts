import path from "node:path";
import type { Context } from "@neoworks/extension-system";
import { registerPythonModel } from "@atlas/server";

interface Dinov2Config {
  device?: "cpu" | "cuda";
  /** timm model name; defaults to the small DINOv2 variant. */
  variant?: string;
}

const PYTHON_DIRECTORY = path.resolve(import.meta.dir, "../py");

function workerEnvironment(config: Dinov2Config): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.device !== undefined) {
    env.ATLAS_DEVICE = config.device;
  }
  if (config.variant !== undefined) {
    env.ATLAS_DINOV2_MODEL = config.variant;
  }
  return env;
}

export default {
  name: "encoder-dinov2",
  inject: ["python", "models", "workspace"],
  apply(ctx: Context, config: Dinov2Config = {}) {
    registerPythonModel(ctx, {
      id: "dinov2",
      label: "DINOv2 (image)",
      module: "atlas_encoder_dinov2.encoder",
      paths: [PYTHON_DIRECTORY],
      requirements: [path.join(PYTHON_DIRECTORY, "requirements.txt")],
      env: workerEnvironment(config),
    });
  },
};
