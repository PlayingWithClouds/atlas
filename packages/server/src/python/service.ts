import path from "node:path";
import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import type { PythonService, PythonWorker, PythonWorkerOptions } from "@atlas/contracts/server";
import { DEFAULT_CALL_TIMEOUT_MS } from "./rpc";
import { PYTHON_PACKAGE_DIRECTORY, ensureInterpreter } from "./environment";
import type { EnvironmentLogger } from "./environment";
import { WorkerSupervisor } from "./supervisor";
import type { LaunchPlan } from "./supervisor";

function pythonPathFor(options: PythonWorkerOptions): string {
  const entries = [PYTHON_PACKAGE_DIRECTORY, ...options.paths];
  if (process.env.PYTHONPATH) {
    entries.push(process.env.PYTHONPATH);
  }
  return entries.join(path.delimiter);
}

function requestedDevice(options: PythonWorkerOptions): string[] {
  const device = options.env?.ATLAS_DEVICE || process.env.ATLAS_DEVICE;
  if (device === "cpu" || device === "cuda") {
    return ["--device", device];
  }
  return [];
}

function buildLaunchPlan(interpreter: string, cacheDirectory: string, options: PythonWorkerOptions): LaunchPlan {
  const command = [interpreter, "-m", "atlas_ml.worker", "--module", options.module, "--cache-root", cacheDirectory, ...requestedDevice(options)];
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[name] = value;
    }
  }
  Object.assign(env, options.env, { PYTHONPATH: pythonPathFor(options), PYTHONUNBUFFERED: "1" });
  return { command, env, label: options.module };
}

function loggerFor(ctx: Context): EnvironmentLogger {
  return {
    info: (message) => ctx.logger.info(message),
    error: (message) => ctx.logger.error(message),
  };
}

// The shared venv is a persistent cache, so there is nothing to undo.
const leaveVenvInPlace = () => {};

/** Two steps so a dispose during venv setup stops before any process is spawned. */
async function* startWorker(supervisor: WorkerSupervisor, cacheDirectory: string, options: PythonWorkerOptions, logger: EnvironmentLogger) {
  let interpreter = "";
  yield ensureInterpreter(cacheDirectory, options.requirements, logger).then(
    (resolved) => {
      interpreter = resolved;
      return leaveVenvInPlace;
    },
    (error: Error) => {
      supervisor.fail(error);
      throw error;
    },
  );
  yield supervisor.start(buildLaunchPlan(interpreter, cacheDirectory, options));
}

class ManagedWorker implements PythonWorker {
  constructor(private readonly supervisor: WorkerSupervisor) {}

  /** Diagnostic only; not part of the PythonWorker contract. */
  get processId(): number | undefined {
    return this.supervisor.processId;
  }

  get running(): boolean {
    return this.supervisor.running;
  }

  call<T = unknown>(method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T> {
    let timeoutMs = DEFAULT_CALL_TIMEOUT_MS;
    if (options !== undefined && options.timeoutMs !== undefined) {
      timeoutMs = options.timeoutMs;
    }
    return this.supervisor.call<T>(method, params, timeoutMs);
  }
}

/** Provides `ctx.python`: spawns `atlas_ml.worker` processes bound to the caller's effect scope. */
export class PythonRuntime extends Service implements PythonService {
  static inject = ["workspace"];

  constructor(ctx: Context) {
    super(ctx, "python");
  }

  spawn(ctx: Context, options: PythonWorkerOptions): PythonWorker {
    const cacheDirectory = this.ctx.workspace.cacheDirectory;
    const logger = loggerFor(ctx);
    const supervisor = new WorkerSupervisor(logger);

    ctx.effect(() => startWorker(supervisor, cacheDirectory, options, logger), `python-worker:${options.module}`);

    return new ManagedWorker(supervisor);
  }
}

export default PythonRuntime;
