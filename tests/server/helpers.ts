import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHost } from "../../packages/server/src/index";
import type { Host, HostOptions } from "../../packages/server/src/index";

export function makeTempDirectory(prefix = "atlas-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function startHost(
  workspaceDirectory = makeTempDirectory(),
  extraOptions: Partial<HostOptions> = {},
): Promise<Host> {
  return createHost({ workspaceDirectory, port: 0, ...extraOptions });
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

export interface ApiResult {
  status: number;
  body: any;
}

/** Thin JSON client for the host's HTTP API. */
export function apiOf(host: Host) {
  async function call(method: string, pathname: string, body?: unknown): Promise<ApiResult> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await fetch(urlOf(host, pathname), init);
    const text = await response.text();
    if (text === "") {
      return { status: response.status, body: undefined };
    }
    return { status: response.status, body: JSON.parse(text) };
  }
  return {
    get: (pathname: string) => call("GET", pathname),
    post: (pathname: string, body: unknown) => call("POST", pathname, body),
    put: (pathname: string, body: unknown) => call("PUT", pathname, body),
    patch: (pathname: string, body: unknown) => call("PATCH", pathname, body),
    delete: (pathname: string) => call("DELETE", pathname),
  };
}

export type Api = ReturnType<typeof apiOf>;

export const SAMPLE_GROUPS = [
  {
    id: "position",
    label: "Position",
    kind: "single",
    primary: true,
    labels: [
      { id: "doggy", name: "Doggy", hotkey: "d" },
      { id: "cowgirl", name: "Cowgirl", hotkey: "c" },
    ],
  },
  {
    id: "extras",
    label: "Extras",
    kind: "multi",
    labels: [
      { id: "toy", name: "Toy" },
      { id: "oil", name: "Oil" },
    ],
  },
  {
    id: "speed",
    label: "Speed",
    kind: "single",
    when: { group: "position", label: "doggy" },
    labels: [{ id: "fast", name: "Fast" }],
  },
];

/** A project with the sample taxonomy, one 100 s video asset and the given number of 10 s items. */
export async function seedProject(api: Api, itemCount: number, projectId = "demo"): Promise<string[]> {
  await api.post("/api/projects", { id: projectId, name: "Demo", taxonomy: { groups: SAMPLE_GROUPS } });
  await api.post(`/api/projects/${projectId}/assets`, [
    { id: "video-1", kind: "video", url: "http://media.test/video-1.mp4", duration: 100 },
  ]);
  const items = [];
  for (let index = 0; index < itemCount; index++) {
    items.push({ id: `video-1#t=${index * 10},${index * 10 + 10}`, assetId: "video-1", span: { start: index * 10, end: index * 10 + 10 } });
  }
  await api.post(`/api/projects/${projectId}/items`, items);
  return items.map((item) => item.id);
}

export const itemPath = (projectId: string, itemId: string) => `/api/projects/${projectId}/items/${encodeURIComponent(itemId)}`;
