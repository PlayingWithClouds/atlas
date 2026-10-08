import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import sharp from "sharp";
import type { Item, ProjectConfig } from "@atlas/contracts";
import type { MediaLocation, NodeType } from "@atlas/contracts/server";
import { makeTempDirectory, startHost, writeAtlasConfig } from "../../../tests/server/helpers";
import type { Host } from "../../../packages/server/src/index";
import { measureBytes, rejects, settingsOf } from "../src/quality";

function projectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    mediaKind: "image",
    model: "fake-model",
    primitives: ["tag"],
    labels: { groups: [{ id: "g", label: "G", classes: [{ name: "a" }, { name: "b" }] }] },
    ...overrides,
  };
}


const packageDirectory = path.resolve(import.meta.dir, "..");
const pluginEntry = { package: "@atlas/plugin-media-image", path: packageDirectory };

function configWith(plugins: unknown[]) {
  return { title: "t", plugins, workflows: [], settings: {} };
}

let host: Host;
let workspaceDirectory: string;
let locations: Record<string, MediaLocation>;
let itemsByRef: Record<string, Item>;

async function pngOf(pixelAt: (x: number, y: number) => number, size = 64): Promise<Buffer> {
  const raw = Buffer.alloc(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      raw[y * size + x] = pixelAt(x, y);
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 1 } }).png().toBuffer();
}

function registerLocations(): void {
  host.context.sources.register({
    id: "fake-src",
    kinds: () => [],
    resolve: async () => ({ label: "x", items: [] }),
    locate: (ref) => locations[ref],
  });
}

function createItems(refs: string[]): void {
  const project = host.context.projects.create("p", projectConfig());
  const session = host.context.items.createSession({
    projectId: project.id,
    label: "s",
    source: { plugin: "fake-src", kind: "k", params: {} },
  });
  const items = host.context.items.append(session.id, refs.map((ref) => ({ ref, mediaKind: "image" })));
  itemsByRef = Object.fromEntries(items.map((item) => [item.ref, item]));
}

beforeEach(async () => {
  workspaceDirectory = makeTempDirectory();
  writeAtlasConfig(workspaceDirectory, configWith([pluginEntry]));
  host = await startHost(workspaceDirectory);
  locations = {};
  registerLocations();
});

afterEach(async () => {
  await host.stop();
  fs.rmSync(workspaceDirectory, { recursive: true, force: true });
});

test("serve streams a file with content type and cache headers", async () => {
  const file = path.join(workspaceDirectory, "a.png");
  const bytes = await pngOf((x) => x * 4);
  fs.writeFileSync(file, bytes);
  locations.a = { kind: "file", path: file };
  createItems(["a"]);

  const mediaKind = host.context.mediaKinds.get("image")!;
  const response = await mediaKind.serve(itemsByRef.a, new Request("http://x/media"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("private, max-age=300");
  expect(response.headers.get("last-modified")).toBeTruthy();
  expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);

  const etag = response.headers.get("etag")!;
  const cached = await mediaKind.serve(itemsByRef.a, new Request("http://x/media", { headers: { "if-none-match": etag } }));
  expect(cached.status).toBe(304);
});

test("serve answers 404 for a missing file", async () => {
  locations.a = { kind: "file", path: path.join(workspaceDirectory, "nope.png") };
  createItems(["a"]);
  const mediaKind = host.context.mediaKinds.get("image")!;
  await expect(mediaKind.serve(itemsByRef.a, new Request("http://x/media"))).rejects.toMatchObject({ status: 404 });
});

test("serve proxies url locations with their headers and 502s on upstream errors", async () => {
  const bytes = await pngOf((x, y) => x + y);
  const seenHeaders: string[] = [];
  const upstream = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/broken") {
        return new Response("no", { status: 500 });
      }
      seenHeaders.push(request.headers.get("x-token") || "");
      return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } });
    },
  });
  try {
    locations.ok = { kind: "url", url: `http://localhost:${upstream.port}/img`, headers: { "x-token": "secret" } };
    locations.broken = { kind: "url", url: `http://localhost:${upstream.port}/broken` };
    locations.down = { kind: "url", url: "http://localhost:1/nothing" };
    createItems(["ok", "broken", "down"]);
    const mediaKind = host.context.mediaKinds.get("image")!;
    const request = new Request("http://x/media");

    const response = await mediaKind.serve(itemsByRef.ok, request);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    expect(seenHeaders).toEqual(["secret"]);

    await expect(mediaKind.serve(itemsByRef.broken, request)).rejects.toMatchObject({ status: 502 });
    await expect(mediaKind.serve(itemsByRef.down, request)).rejects.toMatchObject({ status: 502 });
  } finally {
    upstream.stop(true);
  }
});

test("thumbnail is resized to a smaller webp", async () => {
  const file = path.join(workspaceDirectory, "big.png");
  fs.writeFileSync(file, await pngOf((x, y) => (x * y) % 256, 800));
  locations.big = { kind: "file", path: file };
  createItems(["big"]);
  const response = await host.context.mediaKinds.get("image")!.thumbnail!(itemsByRef.big, new Request("http://x/t"));
  expect(response.headers.get("content-type")).toBe("image/webp");
  const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  expect(metadata.width).toBe(320);
});

test("thumbnail falls back to the original for undecodable files", async () => {
  const file = path.join(workspaceDirectory, "broken.png");
  fs.writeFileSync(file, "not an image");
  locations.broken = { kind: "file", path: file };
  createItems(["broken"]);
  const response = await host.context.mediaKinds.get("image")!.thumbnail!(itemsByRef.broken, new Request("http://x/t"));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("not an image");
});

test("quality metrics and thresholds", async () => {
  const black = await measureBytes(await pngOf(() => 0));
  const white = await measureBytes(await pngOf(() => 255));
  const gray = await measureBytes(await pngOf(() => 128));
  const checker = await measureBytes(await pngOf((x, y) => ((x >> 2) + (y >> 2)) % 2 === 0 ? 0 : 255));
  expect(black!.luma).toBeLessThan(1);
  expect(white!.luma).toBeGreaterThan(250);
  expect(gray!.contrast).toBeLessThan(1);
  expect(checker!.contrast).toBeGreaterThan(50);

  const both = settingsOf({});
  expect(rejects(black, both)).toBe(true);
  expect(rejects(gray, both)).toBe(true);
  expect(rejects(checker, both)).toBe(false);
  expect(rejects(await measureBytes(Buffer.from("junk")), both)).toBe(false);

  expect(rejects(gray, settingsOf({ check: "dark" }))).toBe(false);
  expect(rejects(black, settingsOf({ check: "dark" }))).toBe(true);
  expect(rejects(black, settingsOf({ check: "flat" }))).toBe(true);
  expect(rejects(white, settingsOf({ check: "flat" }))).toBe(true);
  expect(rejects(white, settingsOf({ check: "dark" }))).toBe(false);
});

test("lifecycle: media kind registered, then gone after removal from atlas.json", async () => {
  expect(host.context.mediaKinds.get("image")).toBeDefined();
  writeAtlasConfig(workspaceDirectory, configWith([]));
  await host.context.plugins.reload();
  expect(host.context.mediaKinds.get("image")).toBeUndefined();
});

test("quality node registers while a workflows service exists and runs", async () => {
  const registered: NodeType[] = [];
  const fakeWorkflows = {
    registerNode(nodeType: NodeType) {
      registered.push(nodeType);
      return () => registered.splice(registered.indexOf(nodeType), 1);
    },
  };
  const disposeWorkflows = host.context.provide("workflows", fakeWorkflows as never);
  await Bun.sleep(20);
  expect(registered.map((nodeType) => nodeType.type)).toEqual(["quality"]);
  expect(registered[0].mediaKinds).toEqual(["image"]);

  const dark = path.join(workspaceDirectory, "dark.png");
  const lively = path.join(workspaceDirectory, "lively.png");
  fs.writeFileSync(dark, await pngOf(() => 0));
  fs.writeFileSync(lively, await pngOf((x, y) => ((x >> 2) + (y >> 2)) % 2 === 0 ? 0 : 255));
  locations.dark = { kind: "file", path: dark };
  locations.lively = { kind: "file", path: lively };
  createItems(["dark", "lively"]);
  const workItems = ["dark", "lively"].map((ref) => ({ ref, status: "pending", embedded: false, annotations: [] }));
  const context = { session: { id: itemsByRef.dark.sessionId }, params: { action: "skip" }, job: { progress() {} } };

  const result = await registered[0].run(workItems as never, context as never);
  expect(result.items.map((item) => item.ref)).toEqual(["lively"]);
  expect(host.context.items.get(itemsByRef.dark.id)?.status).toBe("skipped");

  disposeWorkflows();
  await Bun.sleep(20);
  expect(registered).toEqual([]);
});

test("plugin works without a workflows service", () => {
  expect(host.context.workflows).toBeUndefined();
  expect(host.context.mediaKinds.get("image")).toBeDefined();
});
