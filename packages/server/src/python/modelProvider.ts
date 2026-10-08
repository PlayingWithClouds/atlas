import type { Context } from "@neoworks/extension-system";
import type { MediaDescriptor, ModelInsights, ModelProvider, PythonWorker } from "@atlas/contracts/server";

export interface PythonModelOptions {
  /** Provider id projects reference in `config.model`. */
  id: string;
  label: string;
  /** Importable module exposing `create_encoder(device)`. */
  module: string;
  paths: string[];
  requirements: string[];
  env?: Record<string, string>;
}

interface WorkerDescription {
  dim: number;
  mediaKinds: string[];
  capabilities: { textSearch: boolean };
}

const QUICK_TIMEOUT_MS = 20_000;
const HEAVY_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DESCRIBE_ATTEMPT_TIMEOUT_MS = 30_000;
const DESCRIBE_DEADLINE_MS = 600_000;
const DESCRIBE_RETRY_DELAY_MS = 1000;

/** Retries because the first calls fail or stall while the venv is built and the encoder loads. */
async function describeWhenReady(worker: PythonWorker, isCancelled: () => boolean): Promise<WorkerDescription> {
  const deadline = Date.now() + DESCRIBE_DEADLINE_MS;
  let lastError: unknown = new Error("python worker did not become ready");
  while (Date.now() < deadline && !isCancelled()) {
    try {
      return await worker.call<WorkerDescription>("describe", {}, { timeoutMs: DESCRIBE_ATTEMPT_TIMEOUT_MS });
    } catch (error) {
      lastError = error;
      await Bun.sleep(DESCRIBE_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

/** Maps each provider method 1:1 onto the worker's RPC method of the same name. */
function createProvider(options: PythonModelOptions, worker: PythonWorker, description: WorkerDescription): ModelProvider {
  const quick = { timeoutMs: QUICK_TIMEOUT_MS };
  const heavy = { timeoutMs: HEAVY_TIMEOUT_MS };
  const standard = { timeoutMs: DEFAULT_TIMEOUT_MS };
  const provider: ModelProvider = {
    id: options.id,
    label: options.label,
    dim: description.dim,
    mediaKinds: description.mediaKinds,
    capabilities: description.capabilities,
    embed: (projectId, items: MediaDescriptor[]) => worker.call("embed", { projectId, items }, heavy),
    forget: async (projectId, refs) => {
      await worker.call("forget", { projectId, refs }, standard);
    },
    train: (projectId, labeled, classes) => worker.call("train", { projectId, labeled, classes }, standard),
    predict: (projectId, refs, classes) => worker.call("predict", { projectId, refs, classes }, standard),
    rank: (projectId, refs, classes, strategy) => worker.call("rank", { projectId, refs, classes, strategy }, quick),
    duplicates: (projectId, refs, threshold) => worker.call("duplicates", { projectId, refs, threshold }, standard),
    cluster: (projectId, refs, threshold) => worker.call("cluster", { projectId, refs, threshold }, standard),
    similarity: (projectId, refs) => worker.call("similarity", { projectId, refs }, standard),
    insights: (projectId, classes) => worker.call<ModelInsights>("insights", { projectId, classes }, heavy),
    status: (projectId, classes) => worker.call("status", { projectId, classes }, quick),
    poolDump: (projectId) => worker.call("poolDump", { projectId }, standard),
  };
  if (description.capabilities.textSearch) {
    provider.search = (projectId, query, refs, limit) => worker.call("search", { projectId, query, refs, limit }, quick);
  }
  return provider;
}

/**
 * Spawns an `atlas_ml` worker for an encoder module and registers it as a model provider
 * once the worker reports its description. `train` only uses vectors the worker already
 * holds, so callers (the labeling service) must `embed` labeled items first.
 */
export function registerPythonModel(ctx: Context, options: PythonModelOptions): void {
  const worker = ctx.python.spawn(ctx, {
    module: options.module,
    paths: options.paths,
    requirements: options.requirements,
    env: options.env,
  });
  ctx.effect(async function* () {
    let cancelled = false;
    yield () => {
      cancelled = true;
    };
    const description = await describeWhenReady(worker, () => cancelled);
    yield ctx.models.register(createProvider(options, worker, description));
  }, `python-model:${options.id}`);
}
