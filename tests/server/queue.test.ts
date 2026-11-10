import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Host } from "../../packages/server/src/index";
import { apiOf, itemPath, seedProject, startHost } from "./helpers";
import type { Api } from "./helpers";

let host: Host;
let api: Api;
let itemIds: string[];

beforeEach(async () => {
  host = await startHost();
  api = apiOf(host);
  itemIds = await seedProject(api, 5, "p");
});
afterEach(async () => {
  await host.stop();
});

const idsOf = (body: { items: { item: { id: string } }[] }) => body.items.map((view) => view.item.id);
const labeled = { status: "labeled", values: {}, reviewed: [] };

async function suggest(itemId: string, source: string, priority?: number): Promise<void> {
  await api.post("/api/projects/p/suggestions", [{ itemId, source, priority }]);
}

describe("queue/next", () => {
  test("without suggestions the queue follows push order", async () => {
    const first = await api.get("/api/projects/p/queue/next");
    expect(first.body.item.item.id).toBe(itemIds[0]);
    expect(first.body.pending).toBe(5);
    await api.put(`${itemPath("p", itemIds[0])}/annotation`, labeled);
    const second = await api.get("/api/projects/p/queue/next");
    expect(second.body.item.item.id).toBe(itemIds[1]);
    expect(second.body.pending).toBe(4);
  });

  test("highest priority over sources first, items without priority last", async () => {
    await suggest(itemIds[3], "probe-a", 1);
    await suggest(itemIds[3], "probe-b", 9);
    await suggest(itemIds[4], "probe-a", 5);
    await suggest(itemIds[1], "probe-a");
    const order: string[] = [];
    for (let step = 0; step < 5; step++) {
      const next = await api.get("/api/projects/p/queue/next");
      order.push(next.body.item.item.id);
      await api.put(`${itemPath("p", next.body.item.item.id)}/annotation`, labeled);
    }
    expect(order).toEqual([itemIds[3], itemIds[4], itemIds[0], itemIds[1], itemIds[2]]);
    const done = await api.get("/api/projects/p/queue/next");
    expect(done.body).toEqual({ pending: 0 });
  });

  test("equal priorities fall back to push order and after skips that item", async () => {
    await suggest(itemIds[2], "probe", 3);
    await suggest(itemIds[1], "probe", 3);
    const first = await api.get("/api/projects/p/queue/next");
    expect(first.body.item.item.id).toBe(itemIds[1]);
    const after = await api.get(`/api/projects/p/queue/next?after=${encodeURIComponent(itemIds[1])}`);
    expect(after.body.item.item.id).toBe(itemIds[2]);
    expect(after.body.pending).toBe(5);
  });

  test("a negative priority still ranks above no priority", async () => {
    await suggest(itemIds[4], "probe", -2);
    expect((await api.get("/api/projects/p/queue/next")).body.item.item.id).toBe(itemIds[4]);
  });

  test("skipped items are no longer pending", async () => {
    await api.put(`${itemPath("p", itemIds[0])}/annotation`, { status: "skipped", values: {}, reviewed: [] });
    expect((await api.get("/api/projects/p/queue/next")).body.pending).toBe(4);
  });

  test("the answer carries the item view with priority", async () => {
    await suggest(itemIds[0], "probe", 7);
    const view = (await api.get("/api/projects/p/queue/next")).body.item;
    expect(view).toMatchObject({ status: "pending", priority: 7, asset: { id: "video-1" } });
  });
});

describe("item lists", () => {
  test("status filter and cursor paging in push order", async () => {
    await api.put(`${itemPath("p", itemIds[1])}/annotation`, labeled);
    await api.put(`${itemPath("p", itemIds[3])}/annotation`, { status: "skipped", values: {}, reviewed: [] });

    expect(idsOf((await api.get("/api/projects/p/items?status=pending")).body)).toEqual([itemIds[0], itemIds[2], itemIds[4]]);
    expect(idsOf((await api.get("/api/projects/p/items?status=labeled")).body)).toEqual([itemIds[1]]);
    expect(idsOf((await api.get("/api/projects/p/items?status=skipped")).body)).toEqual([itemIds[3]]);
    expect((await api.get("/api/projects/p/items?status=other")).status).toBe(400);

    const firstPage = (await api.get("/api/projects/p/items?limit=2")).body;
    expect(idsOf(firstPage)).toEqual([itemIds[0], itemIds[1]]);
    expect(firstPage.cursor).toBeTruthy();
    const secondPage = (await api.get(`/api/projects/p/items?limit=2&cursor=${firstPage.cursor}`)).body;
    expect(idsOf(secondPage)).toEqual([itemIds[2], itemIds[3]]);
    const lastPage = (await api.get(`/api/projects/p/items?limit=2&cursor=${secondPage.cursor}`)).body;
    expect(idsOf(lastPage)).toEqual([itemIds[4]]);
    expect(lastPage.cursor).toBeUndefined();
  });

  test("a page carries asset, status, priority and annotation", async () => {
    await suggest(itemIds[0], "probe-a", 2);
    await suggest(itemIds[0], "probe-b", 4);
    await api.put(`${itemPath("p", itemIds[0])}/annotation`, labeled);
    const [view] = (await api.get("/api/projects/p/items?limit=1")).body.items;
    expect(view).toMatchObject({ status: "labeled", priority: 4, asset: { id: "video-1" }, annotation: { status: "labeled" } });
  });
});

describe("item detail", () => {
  test("previous and next are adjacent items of the same asset by span start", async () => {
    await api.post("/api/projects/p/assets", [{ id: "video-2", kind: "video", url: "http://media.test/2.mp4", duration: 100 }]);
    await api.post("/api/projects/p/items", [
      { id: "b-late", assetId: "video-2", span: { start: 50, end: 60 } },
      { id: "other", assetId: "video-1", span: { start: 200, end: 210 } },
      { id: "b-early", assetId: "video-2", span: { start: 5, end: 9 } },
      { id: "b-mid", assetId: "video-2", span: { start: 20, end: 30 } },
    ]);
    const middle = (await api.get(itemPath("p", "b-mid"))).body;
    expect(middle.previous.item.id).toBe("b-early");
    expect(middle.next.item.id).toBe("b-late");
    const first = (await api.get(itemPath("p", "b-early"))).body;
    expect(first.previous).toBeUndefined();
    expect(first.next.item.id).toBe("b-mid");
    const last = (await api.get(itemPath("p", "b-late"))).body;
    expect(last.next).toBeUndefined();
  });

  test("neighbours of the seeded video follow span order and carry their status", async () => {
    await api.put(`${itemPath("p", itemIds[2])}/annotation`, labeled);
    const detail = (await api.get(itemPath("p", itemIds[1]))).body;
    expect(detail.previous.item.id).toBe(itemIds[0]);
    expect(detail.next).toMatchObject({ item: { id: itemIds[2] }, status: "labeled" });
    expect(detail.suggestions).toEqual([]);
  });
});

describe("item detail suggestions", () => {
  test("are ordered by push time, not by source name", async () => {
    await suggest(itemIds[0], "zz-scenes", 1);
    await suggest(itemIds[0], "probe-1", 2);
    await suggest(itemIds[0], "zz-scenes", 3);
    const detail = await api.get(itemPath("p", itemIds[0]));
    expect(detail.body.suggestions.map((suggestion: { source: string }) => suggestion.source)).toEqual(["probe-1", "zz-scenes"]);
  });
});
