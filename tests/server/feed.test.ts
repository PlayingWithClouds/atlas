import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Host } from "../../packages/server/src/index";
import { apiOf, itemPath, seedProject, startHost } from "./helpers";
import type { Api } from "./helpers";

let host: Host;
let api: Api;
let itemIds: string[];

beforeEach(async () => {
  host = await startHost();
  api = apiOf(host);
  itemIds = await seedProject(api, 4, "p");
});
afterEach(async () => {
  await host.stop();
});

const annotationPath = (itemId: string) => `${itemPath("p", itemId)}/annotation`;
const labeled = { status: "labeled", values: { position: ["doggy"] }, reviewed: ["position"] };

test("an empty feed answers the cursor it was given", async () => {
  expect((await api.get("/api/projects/p/annotations")).body).toEqual({ changes: [], cursor: "0" });
  const caughtUp = await api.get("/api/projects/p/annotations?since=17");
  expect(caughtUp.body).toEqual({ changes: [], cursor: "17" });
});

test("changes come in order and the cursor resumes after the last one", async () => {
  await api.put(annotationPath(itemIds[0]), labeled);
  await api.put(annotationPath(itemIds[1]), { status: "skipped", values: {}, reviewed: [] });
  await api.put(annotationPath(itemIds[0]), { status: "labeled", values: { position: ["cowgirl"] }, reviewed: ["position"] });

  const all = (await api.get("/api/projects/p/annotations")).body;
  expect(all.changes.map((change: { itemId: string; kind: string }) => [change.itemId, change.kind])).toEqual([
    [itemIds[0], "saved"],
    [itemIds[1], "saved"],
    [itemIds[0], "saved"],
  ]);
  expect(all.changes[2].annotation.values).toEqual({ position: ["cowgirl"] });
  expect(all.cursor).toBe(all.changes[2].cursor);

  const firstPage = (await api.get("/api/projects/p/annotations?limit=2")).body;
  expect(firstPage.changes).toHaveLength(2);
  const rest = (await api.get(`/api/projects/p/annotations?since=${firstPage.cursor}`)).body;
  expect(rest.changes).toHaveLength(1);
  expect(rest.changes[0].cursor).toBe(all.cursor);

  const nothingNew = (await api.get(`/api/projects/p/annotations?since=${all.cursor}`)).body;
  expect(nothingNew).toEqual({ changes: [], cursor: all.cursor });
});

test("removing an annotation is logged as deleted without annotation", async () => {
  await api.put(annotationPath(itemIds[0]), labeled);
  await api.delete(annotationPath(itemIds[0]));
  await api.delete(annotationPath(itemIds[0]));
  const feed = (await api.get("/api/projects/p/annotations")).body;
  expect(feed.changes.map((change: { kind: string }) => change.kind)).toEqual(["saved", "deleted"]);
  expect(feed.changes[1].annotation).toBeUndefined();
});

test("failed saves leave no trace in the feed", async () => {
  await api.put(annotationPath(itemIds[0]), { status: "labeled", values: { nope: ["x"] }, reviewed: [] });
  expect((await api.get("/api/projects/p/annotations")).body.changes).toEqual([]);
});

test("the feed is per project and rejects foreign cursors", async () => {
  await seedProject(api, 1, "other");
  await api.put(annotationPath(itemIds[0]), labeled);
  expect((await api.get("/api/projects/other/annotations")).body.changes).toEqual([]);
  expect((await api.get("/api/projects/p/annotations?since=abc")).status).toBe(400);
  expect((await api.get("/api/projects/p/annotations?limit=0")).status).toBe(400);
});

test("deleting a labeled item keeps its annotation and logs orphaned", async () => {
  await api.put(annotationPath(itemIds[0]), labeled);
  await api.put(annotationPath(itemIds[1]), { status: "skipped", values: {}, reviewed: [] });
  await api.post("/api/projects/p/items/delete", { ids: [itemIds[0], itemIds[2]] });

  const feed = (await api.get("/api/projects/p/annotations")).body;
  const orphaned = feed.changes.filter((change: { kind: string }) => change.kind === "orphaned");
  expect(orphaned).toHaveLength(1);
  expect(orphaned[0].itemId).toBe(itemIds[0]);
  expect(orphaned[0].annotation).toMatchObject({ status: "labeled", values: { position: ["doggy"] } });

  const listed = (await api.get("/api/projects/p/items")).body.items.map((view: { item: { id: string } }) => view.item.id);
  expect(listed).toEqual([itemIds[1], itemIds[3]]);
  expect((await api.get(itemPath("p", itemIds[0]))).status).toBe(404);
  const summary = (await api.get("/api/projects")).body.find((project: { id: string }) => project.id === "p");
  expect(summary).toMatchObject({ items: 2, labeled: 0, skipped: 1 });
});

test("an orphaned annotation survives and re-attaches when the item is pushed again", async () => {
  await api.put(annotationPath(itemIds[0]), labeled);
  await api.post("/api/projects/p/items/delete", { ids: [itemIds[0]] });
  const database = host.context.db.database;
  const stored = database.query("SELECT COUNT(*) AS count FROM annotations WHERE item_id = ?").get(itemIds[0]) as { count: number };
  expect(stored.count).toBe(1);

  await api.post("/api/projects/p/items", [{ id: itemIds[0], assetId: "video-1", span: { start: 0, end: 10 } }]);
  const detail = await api.get(itemPath("p", itemIds[0]));
  expect(detail.body.status).toBe("labeled");
  expect(detail.body.annotation.values).toEqual({ position: ["doggy"] });
});

test("an orphaned annotation can be removed explicitly", async () => {
  await api.put(annotationPath(itemIds[0]), labeled);
  await api.post("/api/projects/p/items/delete", { ids: [itemIds[0]] });
  await api.delete(annotationPath(itemIds[0]));
  const kinds = (await api.get("/api/projects/p/annotations")).body.changes.map((change: { kind: string }) => change.kind);
  expect(kinds).toEqual(["saved", "orphaned", "deleted"]);
});
