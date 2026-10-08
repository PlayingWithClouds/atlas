import { expect, test } from "bun:test";
import type { Item } from "../../packages/contracts/src/index";
import { fakeModel, fakePrimitive, fakeSource, mountProviders, projectConfig } from "./fakes";
import { startHost, urlOf } from "./helpers";
import type { Host } from "../../packages/server/src/index";

const SOURCE = { plugin: "fake-source", kind: "list", params: { name: "x" } };
const modelState = { trained: [], failTraining: false, rankOrder: [], forgotten: [], predictions: {} };

async function getJson(host: Host, pathname: string) {
  return (await fetch(urlOf(host, pathname))).json();
}

async function seedSession(host: Host) {
  const project = host.context.projects.create("p", projectConfig());
  const session = host.context.items.createSession({ projectId: project.id, label: "s", source: SOURCE });
  const items = host.context.items.append(session.id, [
    { ref: "a", mediaKind: "fake-media" },
    { ref: "b", mediaKind: "fake-media" },
  ]);
  return { project, session, items };
}

test("catalog routes list media kinds, primitives and models", async () => {
  const host = await startHost();
  await mountProviders(host, {
    model: fakeModel(modelState),
    primitive: fakePrimitive,
    mediaKind: { id: "fake-media", label: "Fake media", serve: async () => new Response("") },
  });

  expect(await getJson(host, "/api/media-kinds")).toEqual([{ id: "fake-media", label: "Fake media" }]);
  expect(await getJson(host, "/api/primitives")).toEqual([{ id: "fake-tag", label: "Fake tag" }]);
  expect(await getJson(host, "/api/models")).toEqual([
    { id: "fake-model", label: "Fake", dim: 2, mediaKinds: ["fake-media"], capabilities: { textSearch: false } },
  ]);
  await host.stop();
});

test("session opened and closed routes emit events", async () => {
  const host = await startHost();
  const { session } = await seedSession(host);
  const seen: string[] = [];
  host.context.on("session/opened", (opened) => void seen.push(`opened:${opened.id}`));
  host.context.on("session/closed", (closed) => void seen.push(`closed:${closed.id}`));

  await fetch(urlOf(host, `/api/sessions/${session.id}/opened`), { method: "POST", body: "{}" });
  await fetch(urlOf(host, `/api/sessions/${session.id}/closed`), { method: "POST", body: "{}" });
  expect(seen).toEqual([`opened:${session.id}`, `closed:${session.id}`]);

  const missing = await fetch(urlOf(host, "/api/sessions/nope/opened"), { method: "POST", body: "{}" });
  expect(missing.status).toBe(404);
  await host.stop();
});

test("item opened fires on next and item fetch, item rejected fires on skip", async () => {
  const host = await startHost();
  await mountProviders(host, { model: fakeModel(modelState), primitive: fakePrimitive });
  const { session, items } = await seedSession(host);
  const opened: Item[] = [];
  const rejected: Item[] = [];
  host.context.on("item/opened", (item) => void opened.push(item));
  host.context.on("item/rejected", (item) => void rejected.push(item));

  const next = await getJson(host, `/api/sessions/${session.id}/next`);
  await getJson(host, `/api/items/${items[1].id}`);
  expect(opened.map((item) => item.id)).toEqual([next.item.id, items[1].id]);

  await fetch(urlOf(host, `/api/items/${items[0].id}/skip`), { method: "POST", body: "{}" });
  expect(rejected.map((item) => item.id)).toEqual([items[0].id]);
  expect(rejected[0].status).toBe("skipped");
  await host.stop();
});
