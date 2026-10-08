import { expect, test } from "bun:test";
import { fakeModel, fakePrimitive, fakeSource, mountProviders, projectConfig } from "./fakes";
import { startHost, urlOf, waitFor } from "./helpers";
import type { Host } from "../../packages/server/src/index";

const SOURCE = { plugin: "fake-source", kind: "list", params: { name: "x", other: 1 } };

async function postJson(host: Host, pathname: string, body: unknown) {
  return fetch(urlOf(host, pathname), { method: "POST", body: JSON.stringify(body) });
}

async function setupProject(host: Host) {
  return host.context.projects.create("p", projectConfig());
}

test("session creation resolves through the provider and resumes on identical source", async () => {
  const host = await startHost();
  const state = { trained: [], failTraining: false, rankOrder: [], forgotten: [], predictions: {} };
  await mountProviders(host, { source: fakeSource(3), model: fakeModel(state), primitive: fakePrimitive });
  const project = await setupProject(host);

  const created = await (await postJson(host, "/api/sessions", { projectId: project.id, source: SOURCE })).json();
  expect(created.resumed).toBe(false);
  expect(created.total).toBe(3);
  expect(created.modelTrained).toBe(true);
  expect(created.poolSize).toBe(7);
  expect(created.session.label).toBe("resolved x");

  const reordered = { plugin: "fake-source", kind: "list", params: { other: 1, name: "x" } };
  const resumed = await (await postJson(host, "/api/sessions", { projectId: project.id, source: reordered })).json();
  expect(resumed.resumed).toBe(true);
  expect(resumed.session.id).toBe(created.session.id);

  const list = await (await fetch(urlOf(host, `/api/sessions?projectId=${project.id}`))).json();
  expect(list).toHaveLength(1);

  const items = await (await fetch(urlOf(host, `/api/sessions/${created.session.id}/items`))).json();
  expect(items.map((item: { ref: string }) => item.ref)).toEqual(["ref-0", "ref-1", "ref-2"]);

  const next = await (await fetch(urlOf(host, `/api/sessions/${created.session.id}/next`))).json();
  expect(next.item.ref).toBe("ref-0");

  const detail = await (await fetch(urlOf(host, `/api/items/${items[0].id}`))).json();
  expect(detail.threshold).toBe(0.5);

  const labelResponse = await postJson(host, `/api/items/${items[0].id}/label`, {
    annotations: [{ type: "fake-tag", value: { classes: ["a"] } }],
  });
  expect((await labelResponse.json()).status).toBe("labeled");

  const removed = await fetch(urlOf(host, `/api/sessions/${created.session.id}`), { method: "DELETE" });
  expect(removed.status).toBe(200);
  expect((await fetch(urlOf(host, `/api/sessions/${created.session.id}`))).status).toBe(404);
  await host.stop();
});

test("missing model, media kind and source provider answer 503", async () => {
  const host = await startHost();
  const project = await setupProject(host);

  const noSource = await postJson(host, "/api/sessions", { projectId: project.id, source: SOURCE });
  expect(noSource.status).toBe(503);
  expect((await noSource.json()).detail).toContain("fake-source");

  const session = host.context.items.createSession({ projectId: project.id, label: "s", source: SOURCE });
  const [item] = host.context.items.append(session.id, [{ ref: "a", mediaKind: "fake-media" }]);

  const insights = await fetch(urlOf(host, `/api/projects/${project.id}/insights`));
  expect(insights.status).toBe(503);
  expect((await insights.json()).detail).toBe('model provider "fake-model" is not loaded');

  const media = await fetch(urlOf(host, `/api/items/${item.id}/media`));
  expect(media.status).toBe(503);
  expect((await fetch(urlOf(host, `/api/items/${item.id}/thumbnail`))).status).toBe(503);
  await host.stop();
});

test("media kinds serve media and fall back to serve for thumbnails", async () => {
  const host = await startHost();
  const project = await setupProject(host);
  const session = host.context.items.createSession({ projectId: project.id, label: "s", source: SOURCE });
  const [item] = host.context.items.append(session.id, [{ ref: "a", mediaKind: "fake-media" }]);
  await mountProviders(host, {
    mediaKind: { id: "fake-media", label: "Fake", serve: async () => new Response("bytes") },
  });
  expect(await (await fetch(urlOf(host, `/api/items/${item.id}/thumbnail`))).text()).toBe("bytes");
  await host.stop();
});

test("span patch enforces minimum length, forgets the old ref and resets embedded", async () => {
  const host = await startHost();
  const state = { trained: [], failTraining: false, rankOrder: [], forgotten: [] as string[], predictions: {} };
  await mountProviders(host, { model: fakeModel(state) });
  const project = await setupProject(host);
  const session = host.context.items.createSession({ projectId: project.id, label: "s", source: SOURCE });
  const [item] = host.context.items.append(session.id, [
    { ref: "v", mediaKind: "fake-media", span: { start: 0, end: 5 } },
  ]);
  host.context.items.setEmbedded([item.id], true);

  const tooShort = await fetch(urlOf(host, `/api/items/${item.id}/span`), {
    method: "PATCH",
    body: JSON.stringify({ start: 1, end: 1.1 }),
  });
  expect(tooShort.status).toBe(400);

  const patched = await fetch(urlOf(host, `/api/items/${item.id}/span`), {
    method: "PATCH",
    body: JSON.stringify({ start: 1, end: 3 }),
  });
  const body = await patched.json();
  expect(body.span).toEqual({ start: 1, end: 3 });
  expect(body.embedded).toBe(false);
  expect(state.forgotten).toEqual([item.ref]);
  await host.stop();
});

test("unloading a source plugin removes its provider from /api/sources/kinds", async () => {
  const host = await startHost();
  const fiber = mountProviders(host, { source: fakeSource() });
  await fiber;
  const before = await (await fetch(urlOf(host, "/api/sources/kinds"))).json();
  expect(before).toEqual([expect.objectContaining({ id: "list", provider: "fake-source" })]);
  const listing = await (await fetch(urlOf(host, "/api/sources/fake-source/list/items?search=q"))).json();
  expect(listing.items).toHaveLength(1);

  await fiber.dispose();
  await waitFor(() => host.context.sources.list().length === 0);
  expect(await (await fetch(urlOf(host, "/api/sources/kinds"))).json()).toEqual([]);
  await host.stop();
});
