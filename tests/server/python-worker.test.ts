import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Context } from "@neoworks/extension-system";
import type { Fiber } from "@neoworks/extension-system";
import type { PythonWorker, WorkspaceService } from "../../packages/contracts/src/server";
import PythonRuntime from "../../packages/server/src/python/service";
import { makeTempDirectory, waitFor } from "./helpers";

const FIXTURES_DIRECTORY = path.join(import.meta.dir, "fixtures");
const interpreter = process.env.ATLAS_PYTHON || "python3";

function interpreterHasDependencies(): boolean {
  const probe = Bun.spawnSync([interpreter, "-c", "import numpy, PIL, requests"], { stdout: "ignore", stderr: "ignore" });
  return probe.exitCode === 0;
}

function stubWorkspace(directory: string): WorkspaceService {
  return {
    directory,
    cacheDirectory: path.join(directory, "cache"),
    pluginCacheDirectory: (pluginName: string) => path.join(directory, "cache", pluginName),
    config: () => {
      throw new Error("not used");
    },
    saveConfig: () => {
      throw new Error("not used");
    },
  };
}

function isAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function processIdOf(worker: PythonWorker): number {
  const processId = (worker as unknown as { processId?: number }).processId;
  if (processId === undefined) {
    throw new Error("worker has no process");
  }
  return processId;
}

const fibers: Fiber[] = [];

function createRoot(directory = makeTempDirectory("atlas-python-")): Context {
  const root = new Context();
  root.provide("workspace", stubWorkspace(directory));
  root.plugin(PythonRuntime);
  return root;
}

/** Mounts a consumer plugin that spawns a worker inside its own effect scope. */
async function mount(root: Context, module: string): Promise<{ worker: PythonWorker; fiber: Fiber }> {
  let worker: PythonWorker | undefined;
  const consumer = (ctx: Context) => {
    worker = ctx.python.spawn(ctx, { module, paths: [FIXTURES_DIRECTORY], requirements: [] });
  };
  consumer.inject = ["python"];
  const fiber = root.plugin(consumer);
  await fiber;
  fibers.push(fiber);
  if (worker === undefined) {
    throw new Error("consumer did not run");
  }
  return { worker, fiber };
}

const describeWithPython = interpreterHasDependencies() ? describe : describe.skip;

describeWithPython("python worker", () => {
  let previousInterpreter: string | undefined;

  beforeEach(() => {
    previousInterpreter = process.env.ATLAS_PYTHON;
    process.env.ATLAS_PYTHON = interpreter;
  });

  afterEach(async () => {
    for (const fiber of fibers.splice(0)) {
      await fiber.dispose();
    }
    if (previousInterpreter === undefined) {
      delete process.env.ATLAS_PYTHON;
    } else {
      process.env.ATLAS_PYTHON = previousInterpreter;
    }
  });

  test("round-trips calls", async () => {
    const { worker } = await mount(createRoot(), "atlas_ml.testing");
    expect(await worker.call("ping", {})).toBe("pong");
    const description = await worker.call<{ id: string; dim: number }>("describe", {});
    expect(description.id).toBe("fake");
    expect(description.dim).toBe(16);
    expect(worker.running).toBe(true);
  });

  test("unknown methods reject with the worker's message", async () => {
    const { worker } = await mount(createRoot(), "atlas_ml.testing");
    await expect(worker.call("nope", {})).rejects.toThrow("method not found");
  });

  test("a slow call times out without blocking other calls", async () => {
    const { worker } = await mount(createRoot(), "slow_encoder");
    const item = { ref: "a", mediaKind: "image", location: { kind: "file", path: "a" } };
    const slow = worker.call("embed", { projectId: "p", items: [item] }, { timeoutMs: 300 });
    const rejection = expect(slow).rejects.toThrow("timed out");
    expect(await worker.call("ping", {})).toBe("pong");
    await rejection;
  });

  test("a timed-out call makes the worker write its thread stacks to the cache", async () => {
    const directory = makeTempDirectory("atlas-python-");
    const { worker } = await mount(createRoot(directory), "slow_encoder");
    const item = { ref: "a", mediaKind: "image", location: { kind: "file", path: "a" } };
    await expect(worker.call("embed", { projectId: "p", items: [item] }, { timeoutMs: 300 })).rejects.toThrow("timed out");
    const stackFile = path.join(directory, "cache", "worker-stacks.log");
    await waitFor(() => fs.existsSync(stackFile) && fs.readFileSync(stackFile, "utf8").includes("most recent call first"), 5000);
  });

  test("restarts after the child is killed", async () => {
    const { worker } = await mount(createRoot(), "atlas_ml.testing");
    await worker.call("ping", {});
    const firstProcessId = processIdOf(worker);
    process.kill(firstProcessId, "SIGKILL");
    await waitFor(() => !isAlive(firstProcessId));

    expect(await worker.call("ping", {}, { timeoutMs: 10_000 })).toBe("pong");
    expect(processIdOf(worker)).not.toBe(firstProcessId);
  });

  test("a call in flight when the child dies is rejected", async () => {
    const { worker } = await mount(createRoot(), "slow_encoder");
    const item = { ref: "a", mediaKind: "image", location: { kind: "file", path: "a" } };
    const inFlight = worker.call("embed", { projectId: "p", items: [item] });
    await worker.call("ping", {});
    process.kill(processIdOf(worker), "SIGKILL");
    await expect(inFlight).rejects.toThrow("exited");
  });

  test("disposing the effect kills the process and does not restart it", async () => {
    const { worker, fiber } = await mount(createRoot(), "atlas_ml.testing");
    await worker.call("ping", {});
    const processId = processIdOf(worker);
    await fiber.dispose();

    expect(isAlive(processId)).toBe(false);
    expect(worker.running).toBe(false);
    await Bun.sleep(1500);
    expect(worker.running).toBe(false);
    await expect(worker.call("ping", {}, { timeoutMs: 200 })).rejects.toThrow();
  });
});
