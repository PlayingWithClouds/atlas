import { expect, test } from "bun:test";
import { fakeModel, fakePrimitive, fakeSource, mountProviders, projectConfig } from "./fakes";
import type { FakeModelState } from "./fakes";
import { startHost } from "./helpers";

async function setup(stateOverrides: Partial<FakeModelState> = {}) {
  const host = await startHost();
  const state: FakeModelState = {
    trained: [],
    failTraining: false,
    rankOrder: [],
    forgotten: [],
    predictions: {},
    ...stateOverrides,
  };
  await mountProviders(host, { model: fakeModel(state), primitive: fakePrimitive });
  const project = host.context.projects.create("p", projectConfig());
  const session = host.context.items.createSession({
    projectId: project.id,
    label: "s",
    source: { plugin: "x", kind: "k", params: {} },
  });
  const items = host.context.items.append(session.id, [
    { ref: "a", mediaKind: "m" },
    { ref: "b", mediaKind: "m" },
    { ref: "c", mediaKind: "m" },
  ]);
  return { host, state, session, items };
}

test("confirm normalizes, drops unknown primitives and nulls, and trains", async () => {
  const { host, state, items } = await setup();
  const labeled = await host.context.labeling.confirm(items[0].id, [
    { type: "fake-tag", value: { classes: ["a"] } },
    { type: "fake-tag", value: { drop: true } },
    { type: "unknown", value: {} },
  ]);
  expect(labeled.status).toBe("labeled");
  expect(labeled.annotations).toEqual([{ type: "fake-tag", value: { classes: ["a"], normalized: true } }]);
  expect(state.trained).toEqual([[{ ref: "a", labels: ["a"] }]]);
  await host.stop();
});

test("training failure persists a notification and the item stays labeled", async () => {
  const { host, items } = await setup({ failTraining: true });
  const labeled = await host.context.labeling.confirm(items[0].id, [{ type: "fake-tag", value: { classes: ["b"] } }]);
  expect(labeled.status).toBe("labeled");
  const notifications = host.context.notifications.list();
  expect(notifications).toHaveLength(1);
  expect(notifications[0].level).toBe("error");
  expect(notifications[0].message).toContain("boom");
  await host.stop();
});

test("skip never un-labels", async () => {
  const { host, items } = await setup();
  await host.context.labeling.confirm(items[0].id, [{ type: "fake-tag", value: { classes: ["a"] } }]);
  expect(host.context.labeling.skip(items[0].id).status).toBe("labeled");
  expect(host.context.labeling.skip(items[1].id).status).toBe("skipped");
  await host.stop();
});

test("next uses rank order among embedded items, else first pending", async () => {
  const { host, session, items } = await setup({ rankOrder: ["c", "b"] });
  const first = await host.context.labeling.next(session.id);
  expect(first.item?.ref).toBe("a");
  host.context.items.setEmbedded([items[1].id, items[2].id], true);
  const ranked = await host.context.labeling.next(session.id);
  expect(ranked.item?.ref).toBe("c");
  await host.stop();
});

test("no pending items is waiting while producing, done otherwise", async () => {
  const { host, session, items } = await setup();
  for (const item of items) {
    host.context.labeling.skip(item.id);
  }
  expect(await host.context.labeling.next(session.id)).toEqual({ done: true, waiting: false });
  host.context.items.updateSession(session.id, { producing: true });
  expect(await host.context.labeling.next(session.id)).toEqual({ done: false, waiting: true });
  await host.stop();
});

test("backfill trains all labeled items; suggestions come from predict", async () => {
  const { host, state, session, items } = await setup({ predictions: { a: { a: 0.9 } } });
  host.context.items.setAnnotations(items[0].id, [{ type: "fake-tag", value: { classes: ["a"] } }], "labeled");
  host.context.items.setAnnotations(items[1].id, [{ type: "fake-tag", value: { classes: ["b"] } }], "labeled");
  await host.context.labeling.backfill(session.id);
  expect(state.trained[0]).toEqual([
    { ref: "a", labels: ["a"] },
    { ref: "b", labels: ["b"] },
  ]);
  expect(await host.context.labeling.suggestions(items[0])).toEqual({ a: 0.9 });
  await host.stop();
});

test("confirm embeds an unembedded item before training and marks it embedded", async () => {
  const calls: string[] = [];
  const model = fakeModel(
    { trained: [], failTraining: false, rankOrder: [], forgotten: [], predictions: {} },
    {
      embed: async (_projectId, descriptors) => {
        calls.push(`embed:${descriptors.map((descriptor) => descriptor.ref).join(",")}`);
        return { embedded: descriptors.map((descriptor) => descriptor.ref) };
      },
      train: async (_projectId, labeled) => {
        calls.push("train");
        return { poolSize: labeled.length };
      },
    },
  );
  const host = await startHost();
  await mountProviders(host, { model, primitive: fakePrimitive, source: fakeSource() });
  const project = host.context.projects.create("p", projectConfig());
  const session = host.context.items.createSession({
    projectId: project.id,
    label: "s",
    source: { plugin: "fake-source", kind: "list", params: {} },
  });
  const [item] = host.context.items.append(session.id, [{ ref: "ref-0", mediaKind: "fake-media" }]);
  await host.context.labeling.confirm(item.id, [{ type: "fake-tag", value: { classes: ["a"] } }]);
  expect(calls).toEqual(["embed:ref-0", "train"]);
  expect(host.context.items.get(item.id)?.embedded).toBe(true);
  await host.stop();
});
