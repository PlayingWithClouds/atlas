import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Context } from "@neoworks/extension-system";
import type { Fiber } from "@neoworks/extension-system";
import type { ModelProvider, WorkspaceService } from "../../packages/contracts/src/server";
import ModelsCore from "../../packages/server/src/services/models";
import PythonRuntime from "../../packages/server/src/python/service";
import { registerPythonModel } from "../../packages/server/src/python/modelProvider";
import { makeTempDirectory } from "./helpers";

const interpreter = process.env.ATLAS_PYTHON;

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

let workspaceDirectory = "";

function createRoot(): Context {
  const root = new Context();
  workspaceDirectory = makeTempDirectory("atlas-python-model-");
  root.provide("workspace", stubWorkspace(workspaceDirectory));
  root.plugin(PythonRuntime);
  root.plugin(ModelsCore);
  return root;
}

function fakeEncoderPlugin(ctx: Context) {
  registerPythonModel(ctx, { id: "fake", label: "Fake", module: "atlas_ml.testing", paths: [], requirements: [] });
}
fakeEncoderPlugin.inject = ["python", "models"];

function descriptor(ref: string) {
  return { ref, mediaKind: "image", location: { kind: "file" as const, path: ref } };
}

/** The worker's command line carries the unique workspace cache directory. */
function workerIsRunning(): boolean {
  const result = Bun.spawnSync(["pgrep", "-f", workspaceDirectory], { stdout: "ignore", stderr: "ignore" });
  return result.exitCode === 0;
}

async function pollUntil(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error("pollUntil timed out");
    }
    await Bun.sleep(50);
  }
}

const describeWithPython = interpreter ? describe : describe.skip;

describeWithPython("registerPythonModel", () => {
  const fibers: Fiber[] = [];

  beforeEach(() => {
    process.env.ATLAS_PYTHON = interpreter;
  });

  afterEach(async () => {
    for (const fiber of fibers.splice(0)) {
      await fiber.dispose();
    }
  });

  async function mountFake(root: Context): Promise<{ provider: ModelProvider; fiber: Fiber }> {
    const fiber = root.plugin(fakeEncoderPlugin);
    await fiber;
    fibers.push(fiber);
    await pollUntil(async () => root.models.get("fake") !== undefined, 30_000);
    return { provider: root.models.get("fake") as ModelProvider, fiber };
  }

  test("registers after describe with the worker's description", async () => {
    const { provider } = await mountFake(createRoot());
    expect(provider.dim).toBe(16);
    expect(provider.mediaKinds).toEqual(["image", "video"]);
    expect(provider.capabilities.textSearch).toBe(true);
    expect(typeof provider.search).toBe("function");
  });

  test("embed, train, predict and rank round-trip", async () => {
    const { provider } = await mountFake(createRoot());
    const refs = ["a", "b", "c", "d", "e", "f"];
    const embedded = await provider.embed("p", refs.map(descriptor));
    expect(embedded.embedded.sort()).toEqual(refs);

    const labeled = refs.map((ref, index) => ({ ref, labels: [index % 2 === 0 ? "even" : "odd"] }));
    const trained = await provider.train("p", labeled, ["even", "odd"]);
    expect(trained.poolSize).toBe(6);
    expect((await provider.status("p", ["even", "odd"])).trained).toBe(true);

    await pollUntil(async () => Object.keys((await provider.predict("p", ["a"], ["even", "odd"])).a).length > 0, 15_000);
    const predictions = await provider.predict("p", ["a"], ["even", "odd"]);
    expect(Object.keys(predictions.a).sort()).toEqual(["even", "odd"]);

    const ranking = await provider.rank("p", refs, ["even", "odd"]);
    expect(ranking.trained).toBe(true);
    expect([...ranking.order].sort()).toEqual(refs);

    const hits = await provider.search?.("p", "query", refs, 2);
    expect(hits).toHaveLength(2);
  });

  test("disposing the plugin removes the provider and kills the worker", async () => {
    const root = createRoot();
    const { fiber } = await mountFake(root);
    expect(workerIsRunning()).toBe(true);
    await fiber.dispose();
    expect(root.models.get("fake")).toBeUndefined();
    expect(workerIsRunning()).toBe(false);
  });
});
