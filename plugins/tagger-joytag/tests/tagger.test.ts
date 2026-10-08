import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FiberState } from "@neoworks/extension-system";
import type { Fiber } from "@neoworks/extension-system";
import type { Item, WorkItem } from "@atlas/contracts";
import type { NodeRunContext, PythonWorker } from "@atlas/contracts/server";
import WorkflowsCore from "../../../packages/server/src/services/workflows";
import { createStubWorld } from "../../../tests/server/stubs";
import { MAPPING_REQUIRED_MESSAGE, classProbabilities, loadMapping, parseMapping, topTags } from "../src/mapping";
import { createJoytagNode } from "../src/node";
import taggerJoytag from "../src/server";

const MAPPING = { kiss: ["kissing", "french_kiss"], wave: ["waving"], unseen: ["never_scored"] };

function fakeWorker(scores: Record<string, Record<string, number>>, calls: Record<string, unknown>[] = []): PythonWorker {
  return {
    running: true,
    call: async (method, params) => {
      calls.push({ method, ...params });
      const items = params.items as { ref: string }[];
      return items.map((item) => scores[item.ref] || {}) as never;
    },
  };
}

function storedItem(ref: string): Item {
  return { id: `id-${ref}`, sessionId: "s", index: 0, ref, mediaKind: "image", status: "pending", annotations: [], embedded: false, meta: {} };
}

function workItem(ref: string): WorkItem {
  return { ref, itemId: `id-${ref}`, status: "pending", embedded: false, annotations: [] };
}

function contextWith(params: Record<string, unknown> = {}, primitives = ["tag"]): NodeRunContext {
  return {
    project: { id: "p", name: "P", created: "", updated: "", config: { mediaKind: "image", model: "m", primitives, labels: { groups: [] } } },
    session: {} as never,
    classes: ["kiss", "wave", "unseen"],
    params,
    job: {} as never,
    inputs: [],
    sessionItems: () => [],
  };
}

function nodeFor(scores: Record<string, Record<string, number>>, calls: Record<string, unknown>[] = []) {
  const stored = new Map(Object.keys(scores).map((ref) => [`id-${ref}`, storedItem(ref)]));
  return createJoytagNode({
    items: { get: (itemId: string) => stored.get(itemId) } as never,
    sources: { locate: async (item: Item) => ({ kind: "file", path: `/tmp/${item.ref}` }) } as never,
    worker: fakeWorker(scores, calls),
    mapping: MAPPING,
  });
}

// --- mapping -----------------------------------------------------------------------------

test("classProbabilities max-pools mapped tags and omits classes without signal", () => {
  const probabilities = classProbabilities({ kissing: 0.3, french_kiss: 0.7, waving: 0 }, MAPPING, ["kiss", "wave", "unseen", "other"]);
  expect(probabilities).toEqual({ kiss: 0.7 });
});

test("topTags keeps the strongest tags, rounded", () => {
  expect(topTags({ a: 0.1234, b: 0.9, c: 0.5 }, 2)).toEqual({ b: 0.9, c: 0.5 });
});

test("parseMapping rejects malformed mappings", () => {
  expect(() => parseMapping([])).toThrow("object");
  expect(() => parseMapping({ kiss: "kissing" })).toThrow("kiss");
});

test("loadMapping reads inline config first, then a JSON file relative to the workspace", () => {
  expect(loadMapping({ mapping: MAPPING, mappingFile: "ignored.json" }, "/nowhere")).toEqual(MAPPING);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "joytag-mapping-"));
  fs.writeFileSync(path.join(directory, "m.json"), JSON.stringify(MAPPING));
  expect(loadMapping({ mappingFile: "m.json" }, directory)).toEqual(MAPPING);
  expect(() => loadMapping({ mappingFile: "missing.json" }, directory)).toThrow("cannot read");
  expect(() => loadMapping({}, directory)).toThrow(MAPPING_REQUIRED_MESSAGE);
});

test("the shipped example mapping is a valid mapping", () => {
  const example = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../examples/mapping.json"), "utf8"));
  expect(Object.keys(parseMapping(example)).length).toBeGreaterThan(10);
});

// --- node --------------------------------------------------------------------------------

test("node labels classes whose mapped tags reach the threshold and reports raw scores", async () => {
  const calls: Record<string, unknown>[] = [];
  const node = nodeFor({ a: { french_kiss: 0.8, kissing: 0.5, waving: 0.45, solo: 0.41 }, b: { waving: 0.45 } }, calls);
  const result = await node.run([workItem("a"), workItem("b")], contextWith({ threshold: 0.4 }));
  expect(result.items[0].annotations).toEqual([{ type: "tag", value: { labels: ["kiss", "wave"] } }]);
  expect(result.items[0].taggerScores).toEqual({ french_kiss: 0.8, kissing: 0.5, waving: 0.45, solo: 0.41 });
  expect(result.items[1].annotations).toEqual([{ type: "tag", value: { labels: ["wave"] } }]);
  expect(calls[0].method).toBe("tag");
  expect(calls[0].minScore).toBe(0.4);
  expect((calls[0].items as { location: unknown }[])[0].location).toEqual({ kind: "file", path: "/tmp/a" });
});

test("node annotates with an empty label list when nothing reaches the threshold", async () => {
  const result = await nodeFor({ a: {} }).run([workItem("a")], contextWith());
  expect(result.items[0].annotations).toEqual([{ type: "tag", value: { labels: [] } }]);
});

test("node declares its contract and passes through without a tag primitive", async () => {
  const node = nodeFor({ a: { kissing: 0.9 } });
  expect(node).toMatchObject({ type: "joytag-tag", mediaKinds: ["image"], accepts: { status: "pending" }, emits: { annotation: "tag" }, batch: 8 });
  expect(node.params[0].default).toBe(0.4);
  const items = [workItem("a")];
  const result = await node.run(items, contextWith({}, ["region"]));
  expect(result.items).toBe(items);
  expect(result.message).toContain("no tag primitive");
});

// --- plugin lifecycle --------------------------------------------------------------------

async function mount(config: Record<string, unknown> | undefined) {
  const world = createStubWorld();
  const spawned: string[] = [];
  const provide = (key: string, value: unknown) => (world.context as any).provide(key, value);
  provide("sources", { locate: async () => ({ kind: "file", path: "/tmp/x" }) });
  provide("python", {
    spawn: (_ctx: unknown, options: { module: string; env?: Record<string, string> }) => {
      spawned.push(options.module);
      return fakeWorker({});
    },
  });
  await world.context.plugin(WorkflowsCore as never, undefined as never);
  const fiber = world.context.plugin(taggerJoytag as never, config as never) as Fiber;
  return { world, fiber, spawned };
}

test("mounts with a mapping, registers joytag-tag and removes it on dispose", async () => {
  const { world, fiber, spawned } = await mount({ mapping: MAPPING });
  await fiber;
  expect(spawned).toEqual(["atlas_tagger_joytag.tagger"]);
  expect(world.context.workflows.nodes().map((spec) => spec.type)).toEqual(["joytag-tag"]);
  await fiber.dispose();
  expect(world.context.workflows.nodes()).toEqual([]);
});

test("fails loudly without a mapping instead of guessing one", async () => {
  const { world, fiber } = await mount(undefined);
  const failure = await Promise.resolve(fiber).then(() => undefined, (error: Error) => error);
  expect(failure?.message).toContain(MAPPING_REQUIRED_MESSAGE);
  expect(fiber.state).toBe(FiberState.FAILED);
  expect(world.context.workflows.nodes()).toEqual([]);
});
