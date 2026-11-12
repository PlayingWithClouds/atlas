import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Host } from "../../packages/server/src/index";
import { apiOf, itemPath, seedProject, startHost } from "./helpers";
import type { Api } from "./helpers";

let host: Host;
let api: Api;
let itemIds: string[];

const idsOf = (body: { items: { item: { id: string } }[] }) => body.items.map((view) => view.item.id);

async function suggestValues(itemId: string, doggy: number, toy: number, priority = 0): Promise<void> {
  await api.post("/api/projects/p/suggestions", [
    { itemId, source: "model", priority, values: { position: { doggy, cowgirl: 1 - doggy }, extras: { toy, oil: 0.01 } } },
  ]);
}

beforeEach(async () => {
  host = await startHost();
  api = apiOf(host);
  itemIds = await seedProject(api, 5, "p");
  await suggestValues(itemIds[0], 0.9, 0.5, 1);
  await suggestValues(itemIds[1], 0.6, 0.02, 5);
  await suggestValues(itemIds[2], 0.1, 0.3, 3);
  await suggestValues(itemIds[3], 0.45, 0.02, 2);
  await api.put(`${itemPath("p", itemIds[4])}/annotation`, {
    status: "labeled",
    values: { position: ["doggy"] },
    reviewed: ["position"],
  });
});
afterEach(async () => {
  await host.stop();
});

describe("item filters", () => {
  test("label: labeled with it, or suggested at least likely", async () => {
    const page = await api.get("/api/projects/p/items?label=position.doggy");
    expect(idsOf(page.body)).toEqual([itemIds[0], itemIds[1], itemIds[4]]);
    expect(page.body.items[0].match).toBe(0.9);
  });

  test("unsure on a label, most unsure first with sort=match", async () => {
    const page = await api.get("/api/projects/p/items?unsure=position.doggy&sort=match");
    expect(idsOf(page.body)).toEqual([itemIds[3], itemIds[1]]);
  });

  test("unsure on a group: any of its labels in the band", async () => {
    const page = await api.get("/api/projects/p/items?unsure=extras&margin=0.25");
    expect(idsOf(page.body)).toEqual([itemIds[0], itemIds[2]]);
  });

  test("the default margin is 0.15; others are checked", async () => {
    const page = await api.get("/api/projects/p/items?unsure=extras");
    expect(idsOf(page.body)).toEqual([itemIds[0]]);
    expect((await api.get("/api/projects/p/items?unsure=extras&margin=0.9")).status).toBe(400);
  });

  test("a narrowed list counts its matches, in the status and pending", async () => {
    const page = await api.get("/api/projects/p/items?label=position.doggy&limit=1");
    expect(page.body.items).toHaveLength(1);
    expect(page.body.total).toBe(3);
    expect(page.body.pending).toBe(2);
    expect((await api.get("/api/projects/p/items?limit=1")).body.total).toBeUndefined();
  });

  test("sort=queue follows priority and pages by offset", async () => {
    const first = await api.get("/api/projects/p/items?status=pending&sort=queue&limit=2");
    expect(idsOf(first.body)).toEqual([itemIds[1], itemIds[2]]);
    const second = await api.get(`/api/projects/p/items?status=pending&sort=queue&limit=2&cursor=${first.body.cursor}`);
    expect(idsOf(second.body)).toEqual([itemIds[3], itemIds[0]]);
    expect(second.body.cursor).toBeUndefined();
  });

  test("search matches the item id", async () => {
    const page = await api.get(`/api/projects/p/items?q=${encodeURIComponent("t=20,")}`);
    expect(idsOf(page.body)).toEqual([itemIds[2]]);
  });

  test("unknown groups and labels are rejected", async () => {
    expect((await api.get("/api/projects/p/items?label=position.nope")).status).toBe(400);
    expect((await api.get("/api/projects/p/items?unsure=nope")).status).toBe(400);
    expect((await api.get("/api/projects/p/items?label=position")).status).toBe(400);
  });

  test("queue/next serves only items inside the filter", async () => {
    const next = await api.get("/api/projects/p/queue/next?unsure=extras&margin=0.25");
    expect(next.body.item.item.id).toBe(itemIds[2]);
    const after = await api.get(`/api/projects/p/queue/next?unsure=extras&margin=0.25&after=${encodeURIComponent(itemIds[2])}`);
    expect(after.body.item.item.id).toBe(itemIds[0]);
  });
});

describe("model overview", () => {
  test("counts likely, unsure and labeled per label over pending items", async () => {
    const overview = (await api.get("/api/projects/p/model?margin=0.25")).body;
    expect(overview).toMatchObject({ source: "model", margin: 0.25, pending: 4, suggested: 4 });
    const position = overview.groups.find((group: { group: string }) => group.group === "position");
    expect(position.unsure).toBe(2);
    expect(position.labels[0]).toEqual({ label: "doggy", labeled: 1, likely: 2, unsure: 2 });
  });

  test("without suggestions every count is zero", async () => {
    await seedProject(api, 1, "empty");
    const overview = (await api.get("/api/projects/empty/model")).body;
    expect(overview.source).toBeUndefined();
    expect(overview.groups[0].labels[0]).toEqual({ label: "doggy", labeled: 0, likely: 0, unsure: 0 });
  });
});

describe("semantic search", () => {
  test("similar keeps the items the adapter ranks, best first, with their score", async () => {
    const queries: string[] = [];
    const search = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        queries.push(`${url.searchParams.get("q")}|${url.searchParams.get("limit")}`);
        return Response.json({ items: [{ itemId: itemIds[3], score: 0.31 }, { itemId: itemIds[1], score: 0.2 }, { itemId: "unknown", score: 0.1 }] });
      },
    });
    try {
      await api.patch("/api/projects/p", { semanticSearch: `http://localhost:${search.port}/search` });
      const page = await api.get("/api/projects/p/items?similar=red%20dress&sort=match");
      expect(idsOf(page.body)).toEqual([itemIds[3], itemIds[1]]);
      expect(page.body.items[0].match).toBe(0.31);
      expect(page.body.total).toBe(2);
      const next = await api.get("/api/projects/p/queue/next?similar=red%20dress");
      expect(next.body.item.item.id).toBe(itemIds[3]);
      expect(queries).toEqual(["red dress|2000"]);
    } finally {
      search.stop(true);
    }
  });

  test("by example: like asks with item=, carries at as matchAt, and needs byExample", async () => {
    const asked: string[] = [];
    const search = Bun.serve({
      port: 0,
      fetch(request) {
        asked.push(new URL(request.url).search);
        return Response.json({ items: [{ itemId: itemIds[2], score: 0.8, at: 23.5 }, { itemId: itemIds[1], score: 0.6, at: "x" }] });
      },
    });
    try {
      const url = `http://localhost:${search.port}/search`;
      await api.patch("/api/projects/p", { semanticSearch: { url, byText: true } });
      expect((await api.get(`/api/projects/p/items?like=${encodeURIComponent(itemIds[0])}`)).status).toBe(400);
      const project = await api.patch("/api/projects/p", { semanticSearch: { url, byExample: true } });
      expect(project.body.semanticSearch).toEqual({ url, byExample: true });
      expect((await api.get("/api/projects/p/items?similar=x")).status).toBe(400);
      const page = await api.get(`/api/projects/p/items?like=${encodeURIComponent(itemIds[0])}&sort=match`);
      expect(idsOf(page.body)).toEqual([itemIds[2], itemIds[1]]);
      expect(page.body.items[0].matchAt).toBe(23.5);
      expect(page.body.items[1].matchAt).toBeUndefined();
      const next = await api.get(`/api/projects/p/queue/next?like=${encodeURIComponent(itemIds[0])}`);
      expect(next.body.item.matchAt).toBe(23.5);
      expect(asked[0]).toContain(`item=${encodeURIComponent(itemIds[0])}`);
      expect((await api.get("/api/projects/p/items?like=a&similar=b")).status).toBe(400);
    } finally {
      search.stop(true);
    }
  });

  test("a bare URL still means search by text", async () => {
    const project = await api.patch("/api/projects/p", { semanticSearch: "http://localhost:1/search" });
    expect(project.body.semanticSearch).toEqual({ url: "http://localhost:1/search", byText: true });
    expect((await api.patch("/api/projects/p", { semanticSearch: { url: "ftp://x" } })).status).toBe(422);
  });

  test("without a search URL similar is a 400", async () => {
    expect((await api.get("/api/projects/p/items?similar=x")).status).toBe(400);
  });
});
