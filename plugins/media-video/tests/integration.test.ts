import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Item, Project, Session, WorkItem } from "@atlas/contracts";
import type { NodeRunContext, NodeType, Tool } from "@atlas/contracts/server";
import { fakeModel, fakePrimitive, projectConfig } from "./fakes";
import type { FakeModelState } from "./fakes";
import { makeTempDirectory, startHost, urlOf, writeAtlasConfig } from "../../../tests/server/helpers";
import type { Host } from "../../../packages/server/src/index";
import { FfmpegTools } from "../src/ffmpeg";

const ffmpegAvailable = Bun.spawnSync(["ffmpeg", "-version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const packageDirectory = path.resolve(import.meta.dir, "..");
const pluginEntry = { package: "@atlas/plugin-media-video", path: packageDirectory };

function configWith(plugins: unknown[]) {
  return { title: "t", plugins, workflows: [], settings: {} };
}

/** Three seconds of test pattern followed by three of colour bars: one hard cut at 3s. */
function generateVideo(target: string): void {
  const result = Bun.spawnSync([
    "ffmpeg", "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=160x90:rate=10",
    "-f", "lavfi", "-i", "smptebars=duration=3:size=160x90:rate=10",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p",
    "-c:v", "libx264", "-preset", "ultrafast", target,
  ]);
  if (result.exitCode !== 0) {
    throw new Error("could not generate the test video");
  }
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  let offset = 2;
  while (offset < bytes.length) {
    const marker = bytes[offset + 1];
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8] };
    }
    offset += 2 + length;
  }
  throw new Error("no SOF marker");
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8;
}

let host: Host;
let workspaceDirectory: string;
let videoPath: string;
let nodes: Map<string, NodeType>;
let modelState: FakeModelState;
let embedCalls: string[][];
let similarityScores: number[];
let project: Project;
let session: Session;
let videoItem: Item;

async function startWorld(): Promise<void> {
  workspaceDirectory = makeTempDirectory();
  writeAtlasConfig(workspaceDirectory, configWith([]));
  host = await startHost(workspaceDirectory);
  nodes = new Map();
  // Capture node registrations so tests can run a node without assembling a whole graph.
  const workflows = host.context.workflows;
  const register = workflows.registerNode.bind(workflows);
  workflows.registerNode = (nodeType) => {
    nodes.set(nodeType.type, nodeType);
    return register(nodeType);
  };
  writeAtlasConfig(workspaceDirectory, configWith([pluginEntry]));
  await host.context.plugins.reload();
}

function registerFakes(): void {
  modelState = { trained: [], forgotten: [] };
  embedCalls = [];
  similarityScores = [];
  host.context.primitives.register(fakePrimitive);
  host.context.models.register(
    fakeModel(modelState, {
      embed: async (_projectId, items) => {
        embedCalls.push(items.map((item) => item.ref));
        return { embedded: items.map((item) => item.ref) };
      },
      similarity: async (_projectId, refs) => refs.slice(1).map((_ref, index) => similarityScores[index] ?? 0),
    }),
  );
  host.context.sources.register({
    id: "fake-videos",
    kinds: () => [],
    resolve: async () => ({ label: "x", items: [] }),
    locate: (ref) => ({ kind: "file", path: ref }),
  });
}

function createSession(): void {
  project = host.context.projects.create("p", projectConfig());
  session = host.context.items.createSession({
    projectId: project.id,
    label: "clips",
    source: { plugin: "fake-videos", kind: "videofile", params: {} },
  });
  videoItem = host.context.items.append(session.id, [{ ref: videoPath, mediaKind: "video" }])[0];
}

function workItemsOf(items: Item[]): WorkItem[] {
  return items.map((item) => ({
    ref: item.ref,
    itemId: item.id,
    mediaKind: item.mediaKind,
    status: item.status,
    embedded: item.embedded,
    annotations: item.annotations,
    ...(item.span === undefined ? {} : { span: item.span }),
  }));
}

function runContext(params: Record<string, unknown>): NodeRunContext {
  return {
    project,
    session: host.context.items.getSession(session.id) as Session,
    classes: ["a", "b"],
    params,
    job: { id: "j", signal: new AbortController().signal, progress() {}, phase() {}, setExtra() {} },
    inputs: [],
    sessionItems: () => workItemsOf(host.context.items.list(session.id)),
  };
}

async function runNode(type: string, params: Record<string, unknown>, items: Item[]) {
  const node = nodes.get(type) as NodeType;
  return node.run(workItemsOf(items), runContext(params));
}

function clipsOf(): Item[] {
  return host.context.items.list(session.id).filter((item) => item.span !== undefined);
}

beforeEach(async () => {
  videoPath = path.join(makeTempDirectory("atlas-video-"), "test.mp4");
  if (ffmpegAvailable) {
    generateVideo(videoPath);
  }
  await startWorld();
  registerFakes();
  createSession();
});

afterEach(async () => {
  await host.stop();
  fs.rmSync(workspaceDirectory, { recursive: true, force: true });
  fs.rmSync(path.dirname(videoPath), { recursive: true, force: true });
});

describe.skipIf(!ffmpegAvailable)("with ffmpeg", () => {
  test("probe, poster and scene detection run on a real file", async () => {
    const tools = new FfmpegTools();
    const location = { kind: "file" as const, path: videoPath };
    expect(await tools.probeDuration(location)).toBeCloseTo(6, 0);
    const cuts = await tools.detectSceneCuts(location, 0.3, 6);
    expect(cuts?.some((cut) => Math.abs(cut - 3) < 0.25)).toBe(true);

    const poster = path.join(workspaceDirectory, "frame.jpg");
    expect(await tools.seekFrame(location, poster, 1, 80)).toBe(true);
    expect(isJpeg(fs.readFileSync(poster))).toBe(true);
    expect(jpegSize(fs.readFileSync(poster)).width).toBe(80);
  });

  test("the media kind serves the whole video with bounded ranges and posters", async () => {
    const mediaKind = host.context.mediaKinds.get("video")!;
    const ranged = await mediaKind.serve(videoItem, new Request("http://x/media", { headers: { Range: "bytes=0-99" } }));
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);

    const thumbnail = await mediaKind.thumbnail!(videoItem, new Request("http://x/t"));
    expect(thumbnail.headers.get("cache-control")).toContain("immutable");
    expect(isJpeg(new Uint8Array(await thumbnail.arrayBuffer()))).toBe(true);
  });

  test("a span item plays its encoded clip, and the clip route honours overrides", async () => {
    const [clip] = host.context.items.append(session.id, [{ ref: videoPath, mediaKind: "video", span: { start: 1, end: 3 } }]);
    const mediaKind = host.context.mediaKinds.get("video")!;
    const served = await mediaKind.serve(clip, new Request("http://x/media"));
    const bytes = new Uint8Array(await served.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(4, 8))).toBe("ftyp");
    const cacheDirectory = path.join(workspaceDirectory, "cache", "media-video", "clips", session.id);
    expect(fs.readdirSync(cacheDirectory).filter((name) => name.endsWith(".mp4")).length).toBe(1);

    const response = await fetch(urlOf(host, `/api/items/${clip.id}/clip?start=0.5&end=99999`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("video/mp4");
    expect(fs.readdirSync(cacheDirectory).filter((name) => name.endsWith(".mp4")).length).toBe(2);
    expect(fs.readdirSync(cacheDirectory).some((name) => name.endsWith(".partial"))).toBe(false);

    const notSpan = await fetch(urlOf(host, `/api/items/${videoItem.id}/clip`));
    expect(notSpan.status).toBe(400);
  });

  test("segment in fixed mode cuts, embeds and is idempotent", async () => {
    const first = await runNode("segment", { mode: "fixed", window: 2, stride: 2 }, [videoItem]);
    expect(first.items.length).toBe(3);
    const clips = clipsOf();
    expect(clips.map((clip) => clip.span)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 6 },
    ]);
    expect(clips.every((clip) => clip.embedded && clip.mediaKind === "video")).toBe(true);
    const posters = path.join(workspaceDirectory, "cache", "media-video", "posters", session.id);
    expect(fs.readdirSync(posters).length).toBe(3);
    expect(host.context.items.getSession(session.id)?.producing).toBe(false);
    expect(host.context.items.get(videoItem.id)?.status).toBe("skipped");

    const embedCount = embedCalls.length;
    const second = await runNode("segment", { mode: "fixed", window: 2, stride: 2 }, [videoItem]);
    expect(second.items.length).toBe(3);
    expect(clipsOf().length).toBe(3);
    expect(embedCalls.length).toBe(embedCount);
  });

  test("re-segmenting with new settings drops unlabeled clips and keeps labeled ones", async () => {
    await runNode("segment", { mode: "fixed", window: 2, stride: 2 }, [videoItem]);
    const labeled = clipsOf()[1];
    await host.context.labeling.confirm(labeled.id, [{ type: "fake-tag", value: { classes: ["a"] } }]);

    await runNode("segment", { mode: "fixed", window: 3, stride: 3 }, [videoItem]);
    const ranges = clipsOf().map((clip) => `${clip.span!.start}-${clip.span!.end}`);
    expect(ranges).toEqual(["2-4", "0-3", "3-6"]);
    expect(host.context.items.get(labeled.id)?.status).toBe("labeled");
    expect(modelState.forgotten.sort()).toEqual([`${videoPath}#t=0.000,2.000`, `${videoPath}#t=4.000,6.000`]);
  });

  test("scene mode merges neighbours the model reports as the same content", async () => {
    similarityScores = [0.99];
    const merged = await runNode("segment", { mode: "scenes", window: 6, minLen: 1, merge: 0.9, cutScore: 0.3 }, [videoItem]);
    expect(merged.items.map((item) => item.span)).toEqual([{ start: 0, end: 6 }]);
    // The two atoms were embedded for comparison, then the merged-away ones forgotten.
    expect(embedCalls[0].length).toBe(2);
    expect(modelState.forgotten.length).toBe(2);
  });

  test("scene mode keeps the detected cuts when the model sees different content", async () => {
    similarityScores = [0.1];
    const result = await runNode("segment", { mode: "scenes", window: 6, minLen: 1, merge: 0.9, cutScore: 0.3 }, [videoItem]);
    expect(result.items.length).toBe(2);
    const cut = result.items[0].span!.end;
    expect(Math.abs(cut - 3)).toBeLessThan(0.25);
    // Atoms that became clips are already embedded and are not embedded twice.
    expect(embedCalls.length).toBe(1);
    expect(clipsOf().every((clip) => clip.embedded)).toBe(true);
  });

  test("trim snaps clip edges onto scene cuts and retrains labeled clips", async () => {
    const [first, second] = host.context.items.append(session.id, [
      { ref: videoPath, mediaKind: "video", span: { start: 0, end: 2.7 } },
      { ref: videoPath, mediaKind: "video", span: { start: 2.7, end: 6 } },
    ]);
    await host.context.labeling.confirm(second.id, [{ type: "fake-tag", value: { classes: ["b"] } }]);
    modelState.trained.length = 0;

    const result = await runNode("trim", { tolerance: 0.6, minLen: 1, cutScore: 0.3 }, [first, second]);
    const moved = [first, second].map((item) => host.context.items.get(item.id) as Item);
    expect(Math.abs(moved[0].span!.end - 3)).toBeLessThan(0.25);
    expect(moved[1].span!.start).toBeCloseTo(moved[0].span!.end, 5);
    expect(result.items.map((item) => item.ref)).toEqual(moved.map((item) => item.ref));
    expect(modelState.forgotten).toContain(second.ref);
    expect(modelState.trained.length).toBe(1);
    expect(modelState.trained[0][0].ref).toBe(moved[1].ref);
    expect(moved[1].status).toBe("labeled");
  });

  test("the contact sheet tiles posters into one JPEG with an index", async () => {
    await runNode("segment", { mode: "fixed", window: 2, stride: 2 }, [videoItem]);
    const response = await fetch(urlOf(host, `/api/sessions/${session.id}/sheet?from=1&n=24`));
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(jpegSize(bytes)).toEqual({ width: 3 * 240, height: 135 });

    const outcome = await host.context.tools.call("contact_sheet", { sessionId: session.id }, {});
    expect(outcome.isError).toBe(false);
    const index = JSON.parse(outcome.content[0].text as string);
    expect(index.total).toBe(4);
    expect(index.tiles.length).toBe(4);
    expect(outcome.content[1].mimeType).toBe("image/jpeg");
    const sheet = Buffer.from(outcome.content[1].data as string, "base64");
    expect(jpegSize(sheet)).toEqual({ width: 4 * 240, height: 135 });

    const empty = await fetch(urlOf(host, `/api/sessions/${session.id}/sheet?from=99`));
    expect(empty.status).toBe(404);
  });

  test("extract-frames adds image items located through the frames source", async () => {
    const result = await runNode("extract-frames", { interval: 2 }, [videoItem]);
    expect(result.items.length).toBeGreaterThanOrEqual(3);
    const frames = host.context.items.list(session.id).filter((item) => item.mediaKind === "image");
    expect(frames.length).toBe(result.items.length);
    expect(frames.every((frame) => frame.meta.source === "media-video-frames" && frame.embedded)).toBe(true);

    const provider = host.context.sources.get("media-video-frames")!;
    const location = await provider.locate(frames[0].ref);
    expect(location).toEqual({ kind: "file", path: frames[0].ref });
    expect(isJpeg(fs.readFileSync(frames[0].ref))).toBe(true);
    expect(() => provider.locate("/etc/passwd")).toThrow();
  });
});

describe("lifecycle", () => {
  test("mounting registers everything and unmounting withdraws it", async () => {
    expect(host.context.mediaKinds.get("video")).toBeDefined();
    expect(host.context.sources.get("media-video-frames")).toBeDefined();
    expect([...nodes.keys()].sort()).toEqual(["extract-frames", "segment", "trim"]);
    expect(host.context.tools.list().map((tool: Tool) => tool.name)).toContain("contact_sheet");
    expect(host.context.workflows.nodes().map((spec) => spec.type)).toContain("segment");

    const sessionCache = path.join(workspaceDirectory, "cache", "media-video", "posters", session.id);
    fs.mkdirSync(sessionCache, { recursive: true });
    const probe = (pathname: string) => fetch(urlOf(host, pathname)).then((response) => response.json() as Promise<{ detail: string }>);
    expect((await probe(`/api/items/${videoItem.id}/clip`)).detail).toBe("not a temporal span");
    expect((await probe(`/api/sessions/nope/sheet`)).detail).toBe("session not found");

    writeAtlasConfig(workspaceDirectory, configWith([]));
    await host.context.plugins.reload();

    expect(host.context.mediaKinds.get("video")).toBeUndefined();
    expect(host.context.sources.get("media-video-frames")).toBeUndefined();
    expect(host.context.workflows.nodes().map((spec) => spec.type)).not.toContain("segment");
    expect(host.context.tools.list().map((tool: Tool) => tool.name)).not.toContain("contact_sheet");
    expect((await probe(`/api/items/${videoItem.id}/clip`)).detail).toBe("not found");
    expect((await probe(`/api/items/${videoItem.id}/video`)).detail).toBe("not found");
    expect((await probe(`/api/sessions/${session.id}/sheet`)).detail).toBe("not found");

    // The session/removed listener is gone too: the cache directory survives.
    host.context.items.removeSession(session.id);
    expect(fs.existsSync(sessionCache)).toBe(true);
  });

  test("removing a session deletes its cached clips and posters", async () => {
    const sessionCache = path.join(workspaceDirectory, "cache", "media-video", "clips", session.id);
    fs.mkdirSync(sessionCache, { recursive: true });
    fs.writeFileSync(path.join(sessionCache, "a.mp4"), "x");
    host.context.items.removeSession(session.id);
    expect(fs.existsSync(sessionCache)).toBe(false);
  });
});
