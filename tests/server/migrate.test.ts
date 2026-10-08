import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spanRef } from "../../packages/contracts/src/index";
import {
  convertImageRef,
  mapDefaultProject,
  mapItemRef,
  mapItemStatus,
  mapProjectConfig,
  mapSessionSource,
  mapNodeType,
  mapWorkflow,
  parseModelMap,
  stripRecordPrefix,
  usesJoytagNode,
  DEFAULT_MODEL_MAP,
} from "../../packages/server/src/migrate/mapping";
import type { OldImage, OldSession } from "../../packages/server/src/migrate/mapping";
import { runMigration } from "../../packages/server/src/migrate/migrate";
import type { MigrateOptions } from "../../packages/server/src/migrate/migrate";
import { buildPluginEntries } from "../../packages/server/src/migrate/target";
import { SurrealHttpClient, SurrealUnreachableError } from "../../packages/server/src/migrate/surrealClient";
import { createHost } from "../../packages/server/src/index";
import { makeTempDirectory } from "./helpers";

const REMOTE_URL = "https://cdn.example.com/a/b_1.jpg?x=1&y=2";
const PROXY_REF = `http://localhost:8080/api/img?url=${encodeURIComponent(REMOTE_URL)}`;

function image(overrides: Partial<OldImage>): OldImage {
  return { id: "image:a", idx: 0, ref: "/x.jpg", annotations: [], skipped: false, embedded: false, status: "pending", ...overrides };
}

describe("mapping", () => {
  test("project config maps content kind and model", () => {
    const config = mapProjectConfig(
      { contentKind: "video", model: "siglip", primitives: ["tag"], labels: { groups: [{ id: "g", label: "g", classes: [{ name: "a" }] }] }, source: {} },
      DEFAULT_MODEL_MAP,
    );
    expect(config.mediaKind).toBe("video");
    expect(config.model).toBe("siglip");
    expect(config.source).toBeUndefined();
    expect(config.labels.groups[0].classes[0].name).toBe("a");
  });

  test("missing model means the generic model plugin, which becomes joytag", () => {
    const config = mapProjectConfig({}, DEFAULT_MODEL_MAP);
    expect(config).toEqual({ primitives: ["tag"], labels: { groups: [] }, mediaKind: "image", model: "joytag" });
  });

  test("model map overrides and rejects malformed pairs", () => {
    expect(parseModelMap(["siglip=dinov2-base"]).siglip).toBe("dinov2-base");
    expect(() => parseModelMap(["nonsense"])).toThrow();
    expect(mapProjectConfig({ model: "siglip" }, parseModelMap(["siglip=dinov2-base"])).model).toBe("dinov2-base");
  });

  test("virtual default project keeps classes with icon, info and thumbnail", () => {
    const groups = [{ id: "acts", label: "acts", classes: [{ name: "kiss", icon: "x", info: "i", thumbnail: "/t.jpg" }] }];
    const project = mapDefaultProject({ title: "My Atlas", primitives: ["tag"], labels: { groups } }, DEFAULT_MODEL_MAP, "now");
    expect(project.id).toBe("nsfw-tags");
    expect(project.name).toBe("My Atlas");
    expect(project.config.model).toBe("joytag");
    expect(project.config.mediaKind).toBe("image");
    expect(project.config.labels.groups).toEqual(groups);
  });

  test("session sources", () => {
    expect(mapSessionSource("directory", "/p").source).toEqual({ plugin: "fs", kind: "directory", params: { path: "/p" } });
    expect(mapSessionSource("localvideo", "/v.mp4").source).toEqual({ plugin: "fs", kind: "videofile", params: { path: "/v.mp4" } });
    expect(mapSessionSource("gallery", "gallery:abc").source).toEqual({ plugin: "veil", kind: "gallery", params: { id: "abc" } });
    expect(mapSessionSource("video", "scene:xyz").source).toEqual({ plugin: "veil", kind: "scene", params: { id: "xyz" } });
    expect(mapSessionSource("random", "random").source).toEqual({ plugin: "veil", kind: "random", params: {} });
    expect(mapSessionSource("mystery", "r").warning).toBeDefined();
  });

  test("veil proxy refs become veil image refs", () => {
    expect(convertImageRef(PROXY_REF)).toBe(`veil:image:${REMOTE_URL}`);
    expect(convertImageRef("/home/me/a.jpg")).toBe("/home/me/a.jpg");
    expect(convertImageRef("http://example.com/plain.jpg")).toBe("http://example.com/plain.jpg");
  });

  test("span refs stay identical strings", () => {
    const old = image({ ref: "/v/a.mp4#t=936.000,940.000", t_start: 936, t_end: 940 });
    const mapped = mapItemRef(old);
    expect(mapped.ref).toBe("/v/a.mp4");
    expect(mapped.span).toEqual({ start: 936, end: 940 });
    expect(spanRef(mapped.ref, mapped.span!)).toBe(old.ref);
    expect(convertImageRef(old.ref)).toBe(old.ref);
  });

  test("status mapping", () => {
    expect(mapItemStatus(image({ status: "labeled" }))).toBe("labeled");
    expect(mapItemStatus(image({ status: "ai" }))).toBe("pending");
    expect(mapItemStatus(image({ status: "pending", skipped: true }))).toBe("skipped");
  });

  test("record prefixes are stripped", () => {
    expect(stripRecordPrefix("image:abc", "image")).toBe("abc");
    expect(stripRecordPrefix("session:⟨1ab⟩", "session")).toBe("1ab");
    expect(stripRecordPrefix("abc", "image")).toBe("abc");
  });

  test("old node types map onto the new node names", () => {
    const expected: Record<string, string> = {
      source: "session-items", embed: "embed", "siglip.embed": "embed", predict: "predict", "siglip.predict": "predict",
      dedupe: "dedupe", "siglip.dedupe": "dedupe", cluster: "cluster", propagate: "propagate", segment: "segment",
      filter: "filter", sample: "sample", save: "save", action: "action", notify: "notify", quality: "quality",
      trim: "trim", extract: "extract-frames", "node.tag": "joytag-tag", joytag: "joytag-tag",
      "future.embed": "embed", "something-else": "something-else",
    };
    for (const [oldType, newType] of Object.entries(expected)) {
      expect(mapNodeType(oldType)).toBe(newType);
    }
  });

  test("workflows map node types and report whether joytag is needed", () => {
    const old = (type: string) => mapWorkflow({ id: "w", label: "W", graph: { nodes: [{ id: "n", type }], edges: [] } });
    expect(old("source").graph.nodes[0].type).toBe("session-items");
    expect(usesJoytagNode([old("embed"), old("filter")])).toBe(false);
    expect(usesJoytagNode([old("embed"), old("node.tag")])).toBe(true);
  });

  test("plugin entries always enable model-nodes and add tagger-joytag only on request", () => {
    const packages = (include: boolean) => buildPluginEntries("/nonexistent-veil", [], include).map((entry) => entry.package);
    expect(packages(false)).toContain("@atlas/plugin-model-nodes");
    expect(packages(false)).not.toContain("@atlas/plugin-tagger-joytag");
    expect(packages(true)).toContain("@atlas/plugin-tagger-joytag");
  });

  test("workflow graphs map pos to position and project to projectId", () => {
    const workflow = mapWorkflow({
      id: "w", label: "W", project: "p", triggers: ["manual"],
      graph: { nodes: [{ id: "n", type: "embed", params: { a: 1 }, pos: { x: 1, y: 2 } }], edges: [{ source: "n", target: "m" }] },
    });
    expect(workflow.projectId).toBe("p");
    expect(workflow.graph.nodes[0]).toEqual({ id: "n", type: "embed", params: { a: 1 }, position: { x: 1, y: 2 } });
  });
});

// --- integration with a fake Surreal HTTP endpoint -------------------------------------------

const OLD_SESSIONS: Record<string, unknown>[] = [
  { id: "s1", project: "", source: "gallery", ref: "gallery:g1", label: "Gallery", frames_dir: "", video: null, producing: false, created: 1783813903, segment: null },
  { id: "s2", project: "vids", source: "localvideo", ref: "/v/a.mp4", label: "Video", frames_dir: "/f", video: { duration: 10 }, producing: false, created: 1783813904, segment: null },
  { id: "s3", project: "ghost", source: "directory", ref: "/nowhere", label: "Orphan", frames_dir: "", video: null, producing: false, created: 1783813905, segment: null },
];

const OLD_IMAGES: Record<string, Record<string, unknown>[]> = {
  s1: [
    { id: "a1", idx: 0, ref: PROXY_REF, annotations: [{ type: "tag", value: { labels: ["kiss"] } }], skipped: false, embedded: true, status: "labeled" },
    { id: "a2", idx: 1, ref: "http://localhost:8080/api/img?url=https%3A%2F%2Fcdn.example.com%2Fb.jpg", annotations: [], skipped: false, embedded: true, status: "pending" },
  ],
  s2: [
    { id: "b1", idx: 0, ref: "/v/a.mp4#t=0.000,4.000", annotations: [], skipped: true, embedded: false, status: "pending", t_start: 0, t_end: 4 },
  ],
  s3: [],
};

function answerFor(statement: string): unknown[] {
  if (statement.includes("FROM project")) {
    return [{ id: "vids", name: "Videos", config: { contentKind: "video", model: "siglip", primitives: ["tag"], labels: { groups: [] } }, created: "2026-01-01T00:00:00Z", updated: "2026-01-02T00:00:00Z" }];
  }
  if (statement.includes("FROM session")) {
    return OLD_SESSIONS;
  }
  if (statement.includes("GROUP BY session")) {
    return Object.entries(OLD_IMAGES).map(([session, rows]) => ({ session, count: rows.length }));
  }
  const match = statement.match(/WHERE session = "([^"]+)".*START (\d+)/);
  if (match === null) {
    throw new Error(`unexpected statement ${statement}`);
  }
  return OLD_IMAGES[match[1]].slice(Number(match[2]));
}

const servers: { stop(): void }[] = [];
afterAll(() => servers.forEach((server) => server.stop()));

function startFakeSurreal(): string {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(request.headers.get("surreal-ns")).toBe("atlas");
      expect(request.headers.get("authorization")).toStartWith("Basic ");
      const statement = await request.text();
      return Response.json([{ status: "OK", time: "1ms", result: answerFor(statement) }]);
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

function writeOldConfig(directory: string): string {
  const configPath = path.join(directory, "atlas.config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    title: "Old Atlas",
    primitives: ["tag"],
    labels: { groups: [{ id: "g", label: "g", classes: [{ name: "kiss", icon: "k" }] }] },
    workflows: [{ id: "w", label: "W", project: "vids", triggers: ["manual"], graph: { nodes: [{ id: "n", type: "nope", pos: { x: 1, y: 2 } }], edges: [] } }],
  }));
  return configPath;
}

function optionsFor(workspace: string, oldCache: string, oldConfigPath: string, extra: Partial<MigrateOptions> = {}): MigrateOptions {
  return {
    targetDirectory: workspace,
    oldConfigPath,
    oldCacheDirectory: oldCache,
    modelMap: DEFAULT_MODEL_MAP,
    dryRun: false,
    force: false,
    skipPools: false,
    veilPluginDirectory: "/nonexistent-veil",
    log: () => {},
    ...extra,
  };
}

const configDirectory = makeTempDirectory("atlas-migrate-source-");
const oldConfigPath = writeOldConfig(configDirectory);
const reader = new SurrealHttpClient({ url: startFakeSurreal(), user: "root", password: "root", namespace: "atlas", database: "atlas" });

/** The migrated atlas.json enables real plugins; the test host only needs the core services. */
async function openWithoutPlugins(workspace: string) {
  const configPath = path.join(workspace, "atlas.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  expect(config.plugins.length).toBeGreaterThan(0);
  fs.writeFileSync(configPath, JSON.stringify({ ...config, plugins: [] }));
  return createHost({ workspaceDirectory: workspace, port: 0 });
}

describe("migration", () => {
  const oldCache = path.join(configDirectory, "cache");
  fs.mkdirSync(oldCache);

  test("dry run reports counts and writes nothing", async () => {
    const workspace = path.join(makeTempDirectory(), "ws");
    const summary = await runMigration(reader, optionsFor(workspace, oldCache, oldConfigPath, { dryRun: true }));
    expect(summary.projects).toEqual([
      { projectId: "vids", sessions: 1, items: 1 },
      { projectId: "nsfw-tags", sessions: 1, items: 2 },
    ]);
    expect(summary.skippedSessions).toEqual(["s3"]);
    expect(fs.existsSync(workspace)).toBe(false);
  });

  test("migrates projects, sessions and items with ids preserved, then refuses a second run", async () => {
    const workspace = path.join(makeTempDirectory(), "ws");
    await runMigration(reader, optionsFor(workspace, oldCache, oldConfigPath));
    const enabled = JSON.parse(fs.readFileSync(path.join(workspace, "atlas.json"), "utf8")).plugins.map((entry: { package: string }) => entry.package);
    expect(enabled).toContain("@atlas/plugin-model-nodes");
    expect(enabled).not.toContain("@atlas/plugin-tagger-joytag");

    const host = await openWithoutPlugins(workspace);
    try {
      const projects = host.context.projects.list();
      expect(projects.map((project) => project.id).sort()).toEqual(["nsfw-tags", "vids"]);
      expect(host.context.projects.get("vids")?.config.mediaKind).toBe("video");

      const session = host.context.items.getSession("s1");
      expect(session?.projectId).toBe("nsfw-tags");
      expect(session?.source).toEqual({ plugin: "veil", kind: "gallery", params: { id: "g1" } });

      const items = host.context.items.list("s1");
      expect(items.map((item) => item.id)).toEqual(["a1", "a2"]);
      expect(items[0].ref).toBe(`veil:image:${REMOTE_URL}`);
      expect(items[0].status).toBe("labeled");
      expect(items[0].annotations).toEqual([{ type: "tag", value: { labels: ["kiss"] } }]);
      expect(items[0].embedded).toBe(false);

      const [clip] = host.context.items.list("s2");
      expect(clip.ref).toBe("/v/a.mp4#t=0.000,4.000");
      expect(clip.span).toEqual({ start: 0, end: 4 });
      expect(clip.status).toBe("skipped");
      expect(clip.mediaKind).toBe("video");
      expect(host.context.items.getSession("s3")).toBeUndefined();
      expect(host.context.workspace.config().workflows[0].graph.nodes[0].position).toEqual({ x: 1, y: 2 });
    } finally {
      await host.stop();
    }

    await expect(runMigration(reader, optionsFor(workspace, oldCache, oldConfigPath))).rejects.toThrow("--force");
    const forced = await runMigration(reader, optionsFor(workspace, oldCache, oldConfigPath, { force: true }));
    expect(forced.projects[1].items).toBe(2);
  }, 30000);

  test("refuses a target overlapping the old cache", async () => {
    await expect(runMigration(reader, optionsFor(path.join(oldCache, "ws"), oldCache, oldConfigPath))).rejects.toThrow("overlaps");
  });

  test("unreachable surreal explains how to start it", async () => {
    const dead = new SurrealHttpClient({ url: "http://127.0.0.1:1", user: "root", password: "root", namespace: "atlas", database: "atlas" });
    await expect(dead.query("SELECT 1")).rejects.toBeInstanceOf(SurrealUnreachableError);
    await expect(dead.query("SELECT 1")).rejects.toThrow("surreal start");
  });
});

// --- pool copy, needs a python with numpy --------------------------------------------------------

const python = process.env.ATLAS_PYTHON;
const poolTest = python ? test : test.skip;

function runPython(code: string): string {
  const result = Bun.spawnSync([python as string, "-c", code]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString();
}

describe("pool copy", () => {
  poolTest("copies, rewrites veil refs and converts vectors.npz without touching the source", async () => {
    const sourceDirectory = makeTempDirectory("atlas-migrate-pool-");
    const oldCache = path.join(sourceDirectory, "cache");
    const globalPool = path.join(oldCache, "global");
    fs.mkdirSync(globalPool, { recursive: true });
    fs.writeFileSync(path.join(globalPool, "meta.json"), JSON.stringify({ model_name: "joytag", dim: 4 }));
    runPython(`
import numpy as np
refs = np.array([${JSON.stringify(PROXY_REF)}, "/local.jpg"], dtype=object)
labels = np.array([["kiss"], []], dtype=object)
np.savez(${JSON.stringify(path.join(globalPool, "trainset.npz"))}, refs=refs, labels=labels, vectors=np.ones((2, 4), dtype=np.float32))
np.savez(${JSON.stringify(path.join(globalPool, "vectors.npz"))}, model_name="joytag", refs=np.array(["/cached.jpg#t=1.000,2.000"], dtype=object), vectors=np.ones((1, 4), dtype=np.float32))
`);
    const sourceBytes = fs.statSync(path.join(globalPool, "trainset.npz")).size;

    const workspace = path.join(makeTempDirectory(), "ws");
    const summary = await runMigration(reader, optionsFor(workspace, oldCache, oldConfigPath, { pythonPath: python }));
    expect(summary.pools[0].rewrittenRefs).toBe(1);

    const copied = path.join(workspace, "cache", "joytag", "nsfw-tags");
    expect(JSON.parse(fs.readFileSync(path.join(copied, "meta.json"), "utf8"))).toEqual({ encoder_id: "joytag", dim: 4 });
    const report = runPython(`
import numpy as np
trainset = np.load(${JSON.stringify(path.join(copied, "trainset.npz"))}, allow_pickle=True)
cache = np.load(${JSON.stringify(path.join(copied, "vectors.npz"))}, allow_pickle=True)
print(list(trainset["refs"]), str(cache["encoder_id"]), list(cache["refs"]))
`);
    expect(report).toContain(`veil:image:${REMOTE_URL}`);
    expect(report).toContain("joytag");
    expect(report).toContain("/cached.jpg#t=1.000,2.000");
    expect(fs.statSync(path.join(globalPool, "trainset.npz")).size).toBe(sourceBytes);

    const host = await openWithoutPlugins(workspace);
    try {
      expect(host.context.items.list("s1")[0].embedded).toBe(true);
      expect(host.context.items.list("s1")[1].embedded).toBe(false);
    } finally {
      await host.stop();
    }
  });
});
