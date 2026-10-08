import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { SourceProvider } from "@atlas/contracts/server";
import { makeTempDirectory, startHost, writeAtlasConfig } from "../../../tests/server/helpers";
import type { Host } from "../../../packages/server/src/index";

const packageDirectory = path.resolve(import.meta.dir, "..");

function configWith(plugins: unknown[]) {
  return { title: "t", plugins, workflows: [], settings: {} };
}

function entryWith(config: Record<string, unknown>) {
  return { package: "@atlas/plugin-source-fs", path: packageDirectory, config };
}

let host: Host;
let workspaceDirectory: string;
let dataDirectory: string;
let videoRoot: string;

function touch(relativePath: string, root = dataDirectory): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "x");
  return target;
}

function provider(): SourceProvider {
  const registered = host.context.sources.get("fs");
  if (!registered) {
    throw new Error("fs source not registered");
  }
  return registered;
}

beforeEach(async () => {
  workspaceDirectory = makeTempDirectory();
  dataDirectory = makeTempDirectory("atlas-data-");
  videoRoot = makeTempDirectory("atlas-videos-");
  writeAtlasConfig(workspaceDirectory, configWith([entryWith({ videoRoot })]));
  host = await startHost(workspaceDirectory);
});

afterEach(async () => {
  await host.stop();
  for (const directory of [workspaceDirectory, dataDirectory, videoRoot]) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("directory resolve sorts naturally, skips .atlas and non-images", async () => {
  touch("img10.jpg");
  touch("img2.JPG");
  touch("img1.png");
  touch("sub/a.webp");
  touch("sub/b.gif");
  touch("notes.txt");
  touch(".atlas/cache.jpg");
  const resolved = await provider().resolve("directory", { path: dataDirectory });
  const names = resolved.items.map((item) => path.relative(dataDirectory, item.ref));
  expect(names).toEqual(["img1.png", "img2.JPG", "img10.jpg", "sub/a.webp", "sub/b.gif"]);
  expect(resolved.items.every((item) => item.mediaKind === "image")).toBe(true);
  expect(resolved.label).toBe(path.basename(dataDirectory));
});

test("directory resolve points video folders at the video kind and rejects bad input", async () => {
  touch("clip.mp4");
  await expect(provider().resolve("directory", { path: dataDirectory })).rejects.toMatchObject({ status: 400 });
  await expect(provider().resolve("directory", { path: path.join(dataDirectory, "missing") })).rejects.toMatchObject({ status: 404 });
  await expect(provider().resolve("directory", {})).rejects.toMatchObject({ status: 400 });
  await expect(provider().resolve("nope", { path: dataDirectory })).rejects.toMatchObject({ status: 400 });
});

test("locate allows handed-out roots and rejects everything else with 403", async () => {
  const image = touch("a.jpg");
  const outside = makeTempDirectory("atlas-secret-");
  const secret = touch("secret.txt", outside);
  try {
    await expect(Promise.resolve().then(() => provider().locate(image))).rejects.toMatchObject({ status: 403 });
    await provider().resolve("directory", { path: dataDirectory });
    expect(await provider().locate(image)).toEqual({ kind: "file", path: fs.realpathSync(image) });

    await expect(Promise.resolve().then(() => provider().locate(secret))).rejects.toMatchObject({ status: 403 });
    const traversal = path.join(dataDirectory, "..", path.basename(outside), "secret.txt");
    await expect(Promise.resolve().then(() => provider().locate(traversal))).rejects.toMatchObject({ status: 403 });
    await expect(Promise.resolve().then(() => provider().locate("relative.jpg"))).rejects.toMatchObject({ status: 403 });

    fs.symlinkSync(secret, path.join(dataDirectory, "link.jpg"));
    await expect(Promise.resolve().then(() => provider().locate(path.join(dataDirectory, "link.jpg")))).rejects.toMatchObject({ status: 403 });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("granted roots persist across reloads and videoRoot is always allowed", async () => {
  const image = touch("a.jpg");
  const video = touch("movie.mp4", videoRoot);
  await provider().resolve("directory", { path: dataDirectory });
  expect(await provider().locate(video)).toEqual({ kind: "file", path: fs.realpathSync(video) });

  writeAtlasConfig(workspaceDirectory, configWith([]));
  await host.context.plugins.reload();
  expect(host.context.sources.get("fs")).toBeUndefined();
  writeAtlasConfig(workspaceDirectory, configWith([entryWith({ videoRoot })]));
  await host.context.plugins.reload();
  expect(await provider().locate(image)).toEqual({ kind: "file", path: fs.realpathSync(image) });
});

test("videofile list filters by name, accepts a folder in the search box and pages", async () => {
  touch("holiday.mp4", videoRoot);
  touch("work/meeting.mkv", videoRoot);
  touch("readme.txt", videoRoot);
  const other = makeTempDirectory("atlas-other-videos-");
  touch("elsewhere.webm", other);
  try {
    const all = await provider().list!("videofile", { search: "", limit: 10, offset: 0 });
    expect(all.items.map((item) => item.title)).toEqual(["holiday.mp4", "meeting.mkv"]);

    const filtered = await provider().list!("videofile", { search: "MEET", limit: 10, offset: 0 });
    expect(filtered.items.map((item) => item.title)).toEqual(["meeting.mkv"]);

    const folder = await provider().list!("videofile", { search: other, limit: 10, offset: 0 });
    expect(folder.items.map((item) => item.title)).toEqual(["elsewhere.webm"]);

    const paged = await provider().list!("videofile", { search: "", limit: 1, offset: 1 });
    expect(paged.items.map((item) => item.title)).toEqual(["meeting.mkv"]);
    expect(paged.items[0].meta?.dir).toBe(path.join(videoRoot, "work"));
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("videofile resolve returns one video item and grants access", async () => {
  const other = makeTempDirectory("atlas-other-videos-");
  const video = touch("clip.mp4", other);
  try {
    const resolved = await provider().resolve("videofile", { path: video });
    expect(resolved.items).toEqual([{ ref: video, mediaKind: "video" }]);
    expect(resolved.label).toBe("clip.mp4");
    expect(resolved.sessionMeta).toBeDefined();
    expect((await provider().locate(video)) as unknown).toEqual({ kind: "file", path: fs.realpathSync(video) });

    await expect(provider().resolve("videofile", { path: other })).rejects.toMatchObject({ status: 400 });
    touch("notes.txt", other);
    await expect(provider().resolve("videofile", { path: path.join(other, "notes.txt") })).rejects.toMatchObject({ status: 400 });
    await expect(provider().resolve("videofile", { path: path.join(other, "gone.mp4") })).rejects.toMatchObject({ status: 404 });
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("lifecycle: source registered on load, gone after removal", async () => {
  expect(host.context.sources.get("fs")).toBeDefined();
  expect((await provider().kinds()).map((kind) => kind.id)).toEqual(["directory", "videofile"]);
  writeAtlasConfig(workspaceDirectory, configWith([]));
  await host.context.plugins.reload();
  expect(host.context.sources.get("fs")).toBeUndefined();
});
