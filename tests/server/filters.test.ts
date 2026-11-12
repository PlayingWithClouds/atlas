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
    const page = await api.get("/api/projects/p/items?unsure=extras");
    expect(idsOf(page.body)).toEqual([itemIds[0], itemIds[2]]);
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
    const next = await api.get("/api/projects/p/queue/next?unsure=extras");
    expect(next.body.item.item.id).toBe(itemIds[2]);
    const after = await api.get(`/api/projects/p/queue/next?unsure=extras&after=${encodeURIComponent(itemIds[2])}`);
    expect(after.body.item.item.id).toBe(itemIds[0]);
  });
});

describe("model overview", () => {
  test("counts likely, unsure and labeled per label over pending items", async () => {
    const overview = (await api.get("/api/projects/p/model")).body;
    expect(overview).toMatchObject({ source: "model", pending: 4, suggested: 4 });
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
