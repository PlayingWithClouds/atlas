import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { WorkerSupervisor } from "../../packages/server/src/python/supervisor";
import { PYTHON_PACKAGE_DIRECTORY } from "../../packages/server/src/python/environment";
import { makeTempDirectory, waitFor } from "./helpers";

const interpreter = process.env.ATLAS_PYTHON || "python3";

function interpreterHasDependencies(): boolean {
  const probe = Bun.spawnSync([interpreter, "-c", "import numpy, PIL, requests"], { stdout: "ignore", stderr: "ignore" });
  return probe.exitCode === 0;
}

function launchPlan() {
  const cacheRoot = path.join(makeTempDirectory("atlas-supervisor-"), "cache");
  return {
    command: [interpreter, "-m", "atlas_ml.worker", "--module", "atlas_ml.testing", "--cache-root", cacheRoot],
    env: { ...process.env, PYTHONPATH: PYTHON_PACKAGE_DIRECTORY } as Record<string, string>,
    label: "test",
  };
}

const errors: string[] = [];
const logger = { info: () => {}, error: (message: string) => errors.push(message) };
const stops: Array<() => Promise<void>> = [];

const describeWithPython = interpreterHasDependencies() ? describe : describe.skip;

describeWithPython("worker supervisor heartbeat", () => {
  afterEach(async () => {
    for (const stop of stops.splice(0)) {
      await stop();
    }
    errors.length = 0;
  });

  test("replaces a worker that stops answering", async () => {
    const supervisor = new WorkerSupervisor(logger, { intervalMs: 200, timeoutMs: 300 });
    stops.push(supervisor.start(launchPlan()));
    expect(await supervisor.call("ping", {}, 10_000)).toBe("pong");
    const frozenProcessId = supervisor.processId;
    if (frozenProcessId === undefined) {
      throw new Error("worker has no process");
    }

    process.kill(frozenProcessId, "SIGSTOP");
    await waitFor(() => supervisor.processId !== undefined && supervisor.processId !== frozenProcessId, 8000);

    expect(await supervisor.call("ping", {}, 10_000)).toBe("pong");
    expect(errors.some((message) => message.includes("stopped answering"))).toBe(true);
  });

  test("a call pending on a frozen worker is rejected instead of hanging", async () => {
    const supervisor = new WorkerSupervisor(logger, { intervalMs: 200, timeoutMs: 300 });
    stops.push(supervisor.start(launchPlan()));
    await supervisor.call("ping", {}, 10_000);
    process.kill(supervisor.processId as number, "SIGSTOP");

    await expect(supervisor.call("describe", {}, 60_000)).rejects.toThrow("stopped answering");
  });
});
