import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Host } from "../../packages/server/src/index";
import { apiOf, itemPath, seedProject, startHost } from "./helpers";
import type { Api } from "./helpers";

let host: Host;
let api: Api;

beforeEach(async () => {
  host = await startHost();
  api = apiOf(host);
  await api.post("/api/projects", { id: "p", name: "P" });
});
afterEach(async () => {
  await host.stop();
});

const asset = (id: string) => ({ id, kind: "video", url: `http://media.test/${id}.mp4`, duration: 60 });

describe("asset batches", () => {
  test("upserts by id and reports per-record errors without stopping the batch", async () => {
    const result = await api.post("/api/projects/p/assets", [
      asset("a"),
      { id: "bad", kind: "audio", url: "x" },
      "not an object",
      { ...asset("b"), duration: -1 },
      asset("c"),
    ]);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(2);
    expect(result.body.errors.map((error: { id: string }) => error.id)).toEqual(["bad", "#2", "b"]);
    expect(result.body.errors[0].message).toContain("kind");
  });

  test("pushing the same id again updates the asset", async () => {
    await api.post("/api/projects/p/assets", [asset("a")]);
    await api.post("/api/projects/p/items", [{ id: "i", assetId: "a" }]);
    await api.post("/api/projects/p/assets", [{ ...asset("a"), title: "Renamed", poster: "http://media.test/a.jpg" }]);
    const detail = await api.get(itemPath("p", "i"));
    expect(detail.body.asset).toMatchObject({ id: "a", title: "Renamed", poster: "http://media.test/a.jpg" });
  });

  test("a batch holds at most 1000 records", async () => {
    const tooMany = Array.from({ length: 1001 }, (_, index) => asset(`a${index}`));
    const refused = await api.post("/api/projects/p/assets", tooMany);
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toContain("1000");

    const accepted = await api.post("/api/projects/p/assets", tooMany.slice(0, 1000));
    expect(accepted.body).toEqual({ ok: 1000, errors: [] });
  });

  test("a body that is not an array and unknown projects are rejected", async () => {
    expect((await api.post("/api/projects/p/assets", { id: "a" })).status).toBe(422);
    expect((await api.post("/api/projects/nope/assets", [])).status).toBe(404);
  });
});

describe("item batches", () => {
  beforeEach(async () => {
    await api.post("/api/projects/p/assets", [asset("a"), { id: "photo", kind: "image", url: "http://media.test/p.jpg" }]);
  });

  test("validates asset and span per record", async () => {
    const result = await api.post("/api/projects/p/items", [
      { id: "ok", assetId: "a", span: { start: 0, end: 10 } },
      { id: "no-asset", assetId: "missing" },
      { id: "past-end", assetId: "a", span: { start: 50, end: 61 } },
      { id: "backwards", assetId: "a", span: { start: 10, end: 5 } },
      { id: "image-with-any-span", assetId: "photo", span: { start: 0, end: 5 } },
      { assetId: "a" },
    ]);
    expect(result.body.ok).toBe(2);
    expect(result.body.errors.map((error: { id: string }) => error.id)).toEqual(["no-asset", "past-end", "backwards", "#5"]);
  });

  test("re-pushing updates in place and keeps push order", async () => {
    await api.post("/api/projects/p/items", [{ id: "first", assetId: "a" }, { id: "second", assetId: "a" }]);
    await api.post("/api/projects/p/items", [{ id: "first", assetId: "a", poster: "http://media.test/new.jpg" }]);
    const list = await api.get("/api/projects/p/items");
    expect(list.body.items.map((view: { item: { id: string } }) => view.item.id)).toEqual(["first", "second"]);
    expect(list.body.items[0].item.poster).toBe("http://media.test/new.jpg");
  });

  test("item ids travel URL-encoded in paths", async () => {
    const awkwardId = "veil:video:3f2a#t=120,185/part 2?x";
    await api.post("/api/projects/p/items", [{ id: awkwardId, assetId: "a", span: { start: 1, end: 2 } }]);
    const detail = await api.get(itemPath("p", awkwardId));
    expect(detail.status).toBe(200);
    expect(detail.body.item.id).toBe(awkwardId);
    expect((await api.get(itemPath("p", "unknown"))).status).toBe(404);
  });

  test("delete is idempotent and removes items from lists and the queue", async () => {
    await api.post("/api/projects/p/items", [{ id: "x", assetId: "a" }, { id: "y", assetId: "a" }]);
    const first = await api.post("/api/projects/p/items/delete", { ids: ["x", "ghost"] });
    expect(first.body).toEqual({ ok: 2, errors: [] });
    const again = await api.post("/api/projects/p/items/delete", { ids: ["x"] });
    expect(again.body.errors).toEqual([]);
    const list = await api.get("/api/projects/p/items");
    expect(list.body.items.map((view: { item: { id: string } }) => view.item.id)).toEqual(["y"]);
    expect((await api.post("/api/projects/p/items/delete", { ids: "x" })).status).toBe(422);
  });

  test("project summary counts items and statuses", async () => {
    await api.post("/api/projects/p/items", [{ id: "x", assetId: "a" }, { id: "y", assetId: "a" }, { id: "z", assetId: "a" }]);
    await api.put(itemPath("p", "x") + "/annotation", { status: "labeled", values: {}, reviewed: [] });
    await api.put(itemPath("p", "y") + "/annotation", { status: "skipped", values: {}, reviewed: [] });
    const summary = (await api.get("/api/projects")).body[0];
    expect(summary).toMatchObject({ id: "p", items: 3, labeled: 1, skipped: 1 });
  });
});

describe("suggestion batches", () => {
  test("latest push per item and source wins; unknown items are per-record errors", async () => {
    const itemIds = await seedProject(api, 2, "s");
    const first = await api.post("/api/projects/s/suggestions", [
      { itemId: itemIds[0], source: "probe-1", values: { position: { doggy: 0.9 } }, priority: 1 },
      { itemId: "ghost", source: "probe-1" },
      { itemId: itemIds[1], source: "probe-1", values: { position: { doggy: 1.5 } } },
    ]);
    expect(first.body.ok).toBe(1);
    expect(first.body.errors.map((error: { id: string }) => error.id)).toEqual(["ghost", itemIds[1]]);

    await api.post("/api/projects/s/suggestions", [
      { itemId: itemIds[0], source: "probe-1", values: { position: { cowgirl: 0.7 } }, priority: 5 },
      { itemId: itemIds[0], source: "probe-2", priority: 2 },
    ]);
    const detail = await api.get(itemPath("s", itemIds[0]));
    expect(detail.body.suggestions).toHaveLength(2);
    expect(detail.body.suggestions[0]).toMatchObject({ source: "probe-1", values: { position: { cowgirl: 0.7 } } });
    expect(detail.body.priority).toBe(5);
  });
});
