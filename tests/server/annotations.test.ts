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
  itemIds = await seedProject(api, 3, "p");
});
afterEach(async () => {
  await host.stop();
});

const annotationPath = (itemId: string) => `${itemPath("p", itemId)}/annotation`;

const doggy = { status: "labeled", values: { position: ["doggy"] }, reviewed: ["position"] };

describe("saving annotations", () => {
  test("a valid annotation is stored with taxonomy version and time", async () => {
    const saved = await api.put(annotationPath(itemIds[0]), { ...doggy, values: { position: ["doggy"], extras: ["toy"] }, reviewed: ["position", "extras"] });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ itemId: itemIds[0], status: "labeled", taxonomyVersion: 1, reviewed: ["position", "extras"] });
    expect(new Date(saved.body.updatedAt).toISOString()).toBe(saved.body.updatedAt);

    const detail = await api.get(itemPath("p", itemIds[0]));
    expect(detail.body.status).toBe("labeled");
    expect(detail.body.annotation).toEqual(saved.body);
  });

  test("saving again replaces the single current annotation", async () => {
    await api.put(annotationPath(itemIds[0]), doggy);
    await api.put(annotationPath(itemIds[0]), { status: "labeled", values: { position: ["cowgirl"] }, reviewed: ["position"] });
    const detail = await api.get(itemPath("p", itemIds[0]));
    expect(detail.body.annotation.values).toEqual({ position: ["cowgirl"] });
  });

  test("a trimmed span is recorded and the item stays as pushed", async () => {
    await api.put(annotationPath(itemIds[0]), { ...doggy, span: { start: 2, end: 8 } });
    const detail = await api.get(itemPath("p", itemIds[0]));
    expect(detail.body.annotation.span).toEqual({ start: 2, end: 8 });
    expect(detail.body.item.span).toEqual({ start: 0, end: 10 });
  });

  test("a skipped annotation is stored", async () => {
    const skipped = await api.put(annotationPath(itemIds[1]), { status: "skipped", values: {}, reviewed: [] });
    expect(skipped.status).toBe(200);
    expect((await api.get(itemPath("p", itemIds[1]))).body.status).toBe("skipped");
  });

  test("ranges inside the item are accepted", async () => {
    const saved = await api.put(annotationPath(itemIds[0]), {
      status: "labeled",
      values: {},
      ranges: [{ group: "extras", label: "toy", start: 1, end: 4 }],
      reviewed: ["extras"],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.ranges).toHaveLength(1);
  });
});

describe("annotation validation answers 422 { errors }", () => {
  async function expectRejected(body: unknown, fragment: string): Promise<void> {
    const response = await api.put(annotationPath(itemIds[0]), body);
    expect(response.status).toBe(422);
    expect(Array.isArray(response.body.errors)).toBe(true);
    expect(response.body.errors.join("\n")).toContain(fragment);
    expect((await api.get(itemPath("p", itemIds[0]))).body.status).toBe("pending");
  }

  test("unknown group and label", async () => {
    await expectRejected({ status: "labeled", values: { nope: ["x"] }, reviewed: [] }, 'unknown group "nope"');
    await expectRejected({ status: "labeled", values: { position: ["nope"] }, reviewed: ["position"] }, 'unknown label "position.nope"');
  });

  test("a single group takes one label", async () => {
    await expectRejected({ status: "labeled", values: { position: ["doggy", "cowgirl"] }, reviewed: ["position"] }, "takes one label");
  });

  test("a group with labels must be reviewed", async () => {
    await expectRejected({ status: "labeled", values: { position: ["doggy"] }, reviewed: [] }, "not in reviewed");
  });

  test("a group whose condition is unmet carries nothing", async () => {
    await expectRejected(
      { status: "labeled", values: { position: ["cowgirl"], speed: ["fast"] }, reviewed: ["position", "speed"] },
      "condition is not met",
    );
  });

  test("ranges must lie inside the item (10 s from its span, not the 100 s asset)", async () => {
    await expectRejected(
      { status: "labeled", values: {}, ranges: [{ group: "extras", label: "toy", start: 5, end: 12 }], reviewed: ["extras"] },
      "ends after the item",
    );
  });

  test("a skipped annotation is empty", async () => {
    await expectRejected({ status: "skipped", values: { position: ["doggy"] }, reviewed: [] }, "skipped");
  });

  test("malformed bodies", async () => {
    await expectRejected({ status: "maybe", values: {}, reviewed: [] }, "status");
    await expectRejected({ status: "labeled", values: [], reviewed: [] }, "values");
    await expectRejected({ status: "labeled", values: {}, reviewed: "position" }, "reviewed");
    await expectRejected({ status: "labeled", values: {}, reviewed: [], span: { start: 5, end: 1 } }, "span");
  });

  test("invalid JSON is a 400 and an unknown item a 404", async () => {
    const response = await fetch(`http://localhost:${host.context.http.port}${annotationPath(itemIds[0])}`, { method: "PUT", body: "{" });
    expect(response.status).toBe(400);
    expect((await api.put(annotationPath("ghost"), doggy)).status).toBe(404);
  });

  test("a whole-asset item uses the asset duration", async () => {
    await api.post("/api/projects/p/items", [{ id: "whole", assetId: "video-1" }]);
    const inside = { status: "labeled", values: {}, ranges: [{ group: "extras", label: "toy", start: 90, end: 99 }], reviewed: ["extras"] };
    expect((await api.put(annotationPath("whole"), inside)).status).toBe(200);
    const outside = { ...inside, ranges: [{ group: "extras", label: "toy", start: 90, end: 101 }] };
    expect((await api.put(annotationPath("whole"), outside)).status).toBe(422);
  });
});

describe("removing annotations", () => {
  test("delete returns to pending and is idempotent", async () => {
    await api.put(annotationPath(itemIds[0]), doggy);
    expect((await api.delete(annotationPath(itemIds[0]))).status).toBe(204);
    expect((await api.get(itemPath("p", itemIds[0]))).body.status).toBe("pending");
    expect((await api.delete(annotationPath(itemIds[0]))).status).toBe(204);
  });
});
