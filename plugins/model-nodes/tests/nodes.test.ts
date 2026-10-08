import { expect, test } from "bun:test";
import type { Item, Project, WorkItem } from "@atlas/contracts";
import type { MediaDescriptor, ModelProvider, NodeRunContext } from "@atlas/contracts/server";
import { fakeModel } from "../../../tests/server/fakes";
import type { FakeModelState } from "../../../tests/server/fakes";
import { createClusterNode } from "../src/nodes/cluster";
import { createDedupeNode } from "../src/nodes/dedupe";
import { createEmbedNode } from "../src/nodes/embed";
import { createPredictNode } from "../src/nodes/predict";
import { createPropagateNode } from "../src/nodes/propagate";
import type { ModelNodeServices } from "../src/support";

function newState(): FakeModelState {
  return { trained: [], failTraining: false, rankOrder: [], forgotten: [], predictions: {} };
}

function project(primitives: string[] = ["tag"]): Project {
  return {
    id: "p",
    name: "P",
    created: "",
    updated: "",
    config: { mediaKind: "image", model: "fake-model", primitives, labels: { groups: [] } },
  };
}

function storedItem(ref: string, overrides: Partial<Item> = {}): Item {
  return {
    id: `id-${ref}`, sessionId: "s", index: 0, ref, mediaKind: "image", status: "pending",
    annotations: [], embedded: false, meta: {}, ...overrides,
  };
}

function workItem(ref: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return { ref, itemId: `id-${ref}`, status: "pending", embedded: false, annotations: [], ...overrides };
}

const tag = (...labels: string[]) => ({ type: "tag", value: { labels } });

interface Harness {
  services: ModelNodeServices;
  embeddedIds: string[];
  describedRefs: string[];
}

function harness(provider: ModelProvider, refs: string[]): Harness {
  const stored = new Map(refs.map((ref) => [`id-${ref}`, storedItem(ref)]));
  const result = { embeddedIds: [], describedRefs: [] } as unknown as Harness;
  result.services = {
    items: {
      get: (itemId: string) => stored.get(itemId),
      setEmbedded: (itemIds: string[]) => result.embeddedIds.push(...itemIds),
    },
    models: { forProject: () => provider },
    sources: {
      locate: async (item: Item) => {
        result.describedRefs.push(item.ref);
        return { kind: "file", path: `/tmp/${item.ref}` };
      },
    },
  } as unknown as ModelNodeServices;
  return result;
}

function contextWith(params: Record<string, unknown> = {}, primitives?: string[]): NodeRunContext {
  return {
    project: project(primitives),
    session: {} as never,
    classes: ["a", "b"],
    params,
    job: {} as never,
    inputs: [],
    sessionItems: () => [],
  };
}

const refsOf = (items: WorkItem[]) => items.map((item) => item.ref);

// --- embed -------------------------------------------------------------------------------

test("embed describes items through the owning source and marks only the embedded ones", async () => {
  const received: MediaDescriptor[][] = [];
  const provider = fakeModel(newState(), {
    embed: async (_projectId, descriptors) => {
      received.push(descriptors);
      return { embedded: ["x"] };
    },
  });
  const world = harness(provider, ["x", "y"]);
  const node = createEmbedNode(world.services);
  const result = await node.run([workItem("x"), workItem("y")], contextWith());
  expect(received[0].map((descriptor) => descriptor.location)).toEqual([
    { kind: "file", path: "/tmp/x" },
    { kind: "file", path: "/tmp/y" },
  ]);
  expect(world.embeddedIds).toEqual(["id-x"]);
  expect(result.items).toEqual([{ ...workItem("x"), embedded: true }]);
  expect(result.message).toContain("1 item");
  expect(node.accepts).toEqual({ embedded: false });
  expect(node.emits).toEqual({ embedded: true });
  expect(node.batch).toBe(16);
});

// --- predict -----------------------------------------------------------------------------

test("predict proposes tags above the threshold and carries confidence and probs", async () => {
  const state = newState();
  state.predictions = { x: { a: 0.9, b: 0.2 }, y: { a: 0.1, b: 0.6 } };
  const node = createPredictNode(harness(fakeModel(state), []).services);
  const result = await node.run([workItem("x"), workItem("y")], contextWith());
  expect(result.message).toBeUndefined();
  expect(result.items[0].annotations).toEqual([tag("a")]);
  expect(result.items[0].confidence).toBe(0.9);
  expect(result.items[1].annotations).toEqual([tag("b")]);
  expect(result.items[1].probs).toEqual({ a: 0.1, b: 0.6 });
  expect(node.accepts).toEqual({ status: "pending", embedded: true });
  expect(node.batch).toBe(64);
});

test("predict honors the threshold param and explains an empty result by the best class", async () => {
  const state = newState();
  state.predictions = { x: { a: 0.3, b: 0.2 } };
  const node = createPredictNode(harness(fakeModel(state), []).services);
  const result = await node.run([workItem("x")], contextWith({ threshold: 0.4 }));
  expect(result.items[0].annotations).toEqual([tag()]);
  expect(result.message).toBe("Predict proposed nothing: no tag reached the 0.40 threshold (best was a at 0.30)");
});

test("predict says so when the model is untrained", async () => {
  const provider = fakeModel(newState(), {
    predict: async () => ({}),
    status: async () => ({ poolSize: 1, trained: false }),
  });
  const node = createPredictNode(harness(provider, []).services);
  const result = await node.run([workItem("x")], contextWith());
  expect(result.message).toContain("not trained yet (1 labeled item in its pool)");
});

test("predict says so when a trained model returns nothing", async () => {
  const provider = fakeModel(newState(), { predict: async () => ({}) });
  const result = await createPredictNode(harness(provider, []).services).run([workItem("x")], contextWith());
  expect(result.message).toContain("no probabilities");
});

test("predict passes items through with a message when the project has no tag primitive", async () => {
  const state = newState();
  state.predictions = { x: { a: 0.9 } };
  const items = [workItem("x")];
  const result = await createPredictNode(harness(fakeModel(state), []).services).run(items, contextWith({}, ["region"]));
  expect(result.items).toBe(items);
  expect(result.message).toContain("no tag primitive");
});

// --- cluster -----------------------------------------------------------------------------

test("cluster numbers groups, flags representatives and treats vectorless items as their own", async () => {
  const provider = fakeModel(newState(), {
    cluster: async (_projectId, _refs, threshold) => {
      expect(threshold).toBe(0.9);
      return [{ keep: "a", members: ["a", "b"] }, { keep: "c", members: ["c"] }];
    },
  });
  const result = await createClusterNode(harness(provider, []).services).run(
    ["a", "b", "c", "lost"].map((ref) => workItem(ref, { embedded: true })),
    contextWith(),
  );
  expect(result.items.map((item) => [item.cluster, item.representative])).toEqual([
    [0, true], [0, false], [1, true], [-1, true],
  ]);
});

// --- dedupe ------------------------------------------------------------------------------

test("dedupe sets the reserved action on duplicates only and keeps one", async () => {
  const provider = fakeModel(newState(), {
    duplicates: async (_projectId, _refs, threshold) => {
      expect(threshold).toBe(0.8);
      return [{ keep: "a", duplicates: ["b", "c"] }];
    },
  });
  const node = createDedupeNode(harness(provider, []).services);
  const items = ["a", "b", "c", "d"].map((ref) => workItem(ref, { embedded: true }));
  const result = await node.run(items, contextWith({ threshold: 0.8, action: "delete" }));
  expect(result.items.map((item) => item.action)).toEqual([undefined, "delete", "delete", undefined]);
  expect(result.items[1].keep).toBe("a");
});

test("dedupe defaults to skip and rejects unknown actions", async () => {
  const provider = fakeModel(newState(), { duplicates: async () => [{ keep: "a", duplicates: ["b"] }] });
  const node = createDedupeNode(harness(provider, []).services);
  const items = [workItem("a"), workItem("b")];
  const result = await node.run(items, contextWith());
  expect(result.items[1].action).toBe("skip");
  await expect(node.run(items, contextWith({ action: "explode" }))).rejects.toThrow("explode");
});

// --- propagate ---------------------------------------------------------------------------

test("propagate copies agreed tags from labeled items to unlabeled cluster mates only", async () => {
  const provider = fakeModel(newState(), {
    cluster: async () => [
      { keep: "src", members: ["src", "near", "far-labeled"] },
      { keep: "alone", members: ["alone"] },
    ],
  });
  const items = [
    workItem("src", { status: "labeled", annotations: [tag("a", "b")] }),
    workItem("far-labeled", { status: "labeled", annotations: [tag("a")] }),
    workItem("near", { annotations: [tag("old")] }),
    workItem("alone", { annotations: [tag("keep-me")] }),
  ];
  const result = await createPropagateNode(harness(provider, []).services).run(items, contextWith());
  expect(refsOf(result.items)).toEqual(["src", "far-labeled", "near", "alone"]);
  expect(result.items[0]).toBe(items[0]);
  expect(result.items[2].annotations).toEqual([tag("a")]);
  expect(result.items[2].propagatedFrom).toBe("src");
  expect(result.items[3]).toBe(items[3]);
});

test("propagate skips clusters whose labeled members share no tag", async () => {
  const provider = fakeModel(newState(), { cluster: async () => [{ keep: "x", members: ["x", "y", "z"] }] });
  const items = [
    workItem("x", { status: "labeled", annotations: [tag("a")] }),
    workItem("y", { status: "labeled", annotations: [tag("b")] }),
    workItem("z"),
  ];
  const result = await createPropagateNode(harness(provider, []).services).run(items, contextWith());
  expect(result.items[2]).toBe(items[2]);
});

test("propagate explains when there is nothing to copy from or onto", async () => {
  const node = createPropagateNode(harness(fakeModel(newState()), []).services);
  const unlabeled = await node.run([workItem("x")], contextWith());
  expect(unlabeled.message).toContain("nothing to copy from");
  const labeled = await node.run([workItem("x", { status: "labeled", annotations: [tag("a")] })], contextWith());
  expect(labeled.message).toContain("nothing to copy onto");
  const noTags = await node.run([workItem("x")], contextWith({}, ["region"]));
  expect(noTags.message).toContain("no tag primitive");
});
