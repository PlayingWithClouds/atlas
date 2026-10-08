import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHost } from "../../packages/server/src/index";
import type { Host } from "../../packages/server/src/index";

export function makeTempDirectory(prefix = "atlas-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function startHost(workspaceDirectory = makeTempDirectory()): Promise<Host> {
  return createHost({ workspaceDirectory, port: 0 });
}

export function urlOf(host: Host, pathname: string): string {
  return `http://localhost:${host.context.http.port}${pathname}`;
}

export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await Bun.sleep(10);
  }
}

export function writeAtlasConfig(workspaceDirectory: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(workspaceDirectory, "atlas.json"), JSON.stringify(config));
}
