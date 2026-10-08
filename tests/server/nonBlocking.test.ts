import { expect, test } from "bun:test";
import { fakeModel, fakePrimitive, mountProviders, projectConfig } from "./fakes";
import type { FakeModelState } from "./fakes";
import { startHost, urlOf, waitFor } from "./helpers";

const never = () => new Promise<never>(() => {});

function newState(): FakeModelState {
  return { trained: [], failTraining: false, rankOrder: [], forgotten: [], predictions: {} };
}

async function setup(state: FakeModelState, overrides: Parameters<typeof fakeModel>[1] = {}) {
  const host = await startHost();
  await mountProviders(host, { model: fakeModel(state, overrides), primitive: fakePrimitive });
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
  return { host, session, items };
}

test("suggestions and status fall back quickly when the provider hangs", async () => {
  const { host, session, items } = await setup(newState(), { predict: never, status: never, rank: never });
  const started = Date.now();
  expect(await host.context.labeling.suggestions(items[0])).toEqual({});
  expect(await host.context.items.status(session.id)).toMatchObject({ modelTrained: false, poolSize: 0 });
  expect(Date.now() - started).toBeLessThan(4000);
  await host.stop();
});

test("next falls back to the first embedded item when rank hangs", async () => {
  const { host, session, items } = await setup(newState(), { rank: never });
  host.context.items.setEmbedded([items[1].id, items[2].id], true);
  const next = await host.context.labeling.next(session.id);
  expect(next.item?.id).toBe(items[1].id);
  await host.stop();
});

test("delete responds while forget hangs", async () => {
  const { host, items } = await setup(newState(), { forget: never });
  const response = await fetch(urlOf(host, `/api/items/${items[0].id}`), { method: "DELETE" });
  expect(response.status).toBe(200);
  expect(host.context.items.get(items[0].id)).toBeUndefined();
  await host.stop();
});

test("failing forget is reported without blocking delete", async () => {
  const failing = async () => {
    throw new Error("forget boom");
  };
  const { host, items } = await setup(newState(), { forget: failing });
  const response = await fetch(urlOf(host, `/api/items/${items[0].id}`), { method: "DELETE" });
  expect(response.status).toBe(200);
  await waitFor(() => host.context.notifications.list().length === 1);
  expect(host.context.notifications.list()[0].message).toContain("forget boom");
  await host.stop();
});

test("quick confirms coalesce into fewer train calls and every label arrives", async () => {
  const state = newState();
  const release: { open: () => void } = { open: () => {} };
  const gate = new Promise<void>((resolve) => {
    release.open = resolve;
  });
  let firstCall = true;
  const { host, items } = await setup(state, {
    train: async (_projectId, labeled) => {
      if (firstCall) {
        firstCall = false;
        await gate;
      }
      state.trained.push(labeled);
      return { poolSize: labeled.length };
    },
  });
  const classes = ["a", "b", "a"];
  for (const [index, item] of items.entries()) {
    await host.context.labeling.confirm(item.id, [{ type: "fake-tag", value: { classes: [classes[index]] } }]);
  }
  release.open();
  await host.context.labeling.idle();
  expect(state.trained.length).toBeLessThan(3);
  const trainedRefs = state.trained.flat().map((example) => example.ref);
  expect(new Set(trainedRefs)).toEqual(new Set(["a", "b", "c"]));
  await host.stop();
});

test("idle resolves after training finished", async () => {
  const state = newState();
  const { host, items } = await setup(state);
  await host.context.labeling.confirm(items[0].id, [{ type: "fake-tag", value: { classes: ["a"] } }]);
  await host.context.labeling.idle();
  expect(state.trained).toEqual([[{ ref: "a", labels: ["a"] }]]);
  await host.stop();
});
