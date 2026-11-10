import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Host } from "../../packages/server/src/index";
import { apiOf, SAMPLE_GROUPS, startHost } from "./helpers";
import type { Api } from "./helpers";

let host: Host;
let api: Api;

beforeEach(async () => {
  host = await startHost();
  api = apiOf(host);
});
afterEach(async () => {
  await host.stop();
});

describe("projects", () => {
  test("create, read, list and conflict", async () => {
    const created = await api.post("/api/projects", { id: "scenes", name: "Scenes", taxonomy: { groups: SAMPLE_GROUPS } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ id: "scenes", name: "Scenes", taxonomy: { version: 1 } });
    expect(created.body.taxonomy.groups).toHaveLength(3);

    expect((await api.get("/api/projects/scenes")).body.name).toBe("Scenes");
    expect((await api.get("/api/projects")).body).toEqual([{ id: "scenes", name: "Scenes", items: 0, labeled: 0, skipped: 0 }]);
    expect((await api.post("/api/projects", { id: "scenes", name: "Again" })).status).toBe(409);
    expect((await api.get("/api/projects/missing")).status).toBe(404);
  });

  test("a project without taxonomy starts empty at version 1", async () => {
    const created = await api.post("/api/projects", { id: "empty", name: "Empty" });
    expect(created.body.taxonomy).toEqual({ version: 1, groups: [] });
  });

  test("invalid projects answer 422 with errors", async () => {
    const badId = await api.post("/api/projects", { id: "Bad Id", name: "x" });
    expect(badId.status).toBe(422);
    expect(badId.body.errors).toHaveLength(1);

    const duplicateGroups = await api.post("/api/projects", {
      id: "dup",
      name: "x",
      taxonomy: { groups: [SAMPLE_GROUPS[0], SAMPLE_GROUPS[0]] },
    });
    expect(duplicateGroups.status).toBe(422);
    expect(duplicateGroups.body.errors[0]).toContain("defined twice");
  });

  test("patch changes name and prefill source, null clears it", async () => {
    await api.post("/api/projects", { id: "p", name: "Old" });
    const renamed = await api.patch("/api/projects/p", { name: "New", prefillSource: "probe-3" });
    expect(renamed.body).toMatchObject({ name: "New", prefillSource: "probe-3" });
    const cleared = await api.patch("/api/projects/p", { prefillSource: null });
    expect(cleared.body.prefillSource).toBeUndefined();
    expect((await api.patch("/api/projects/p", { prefillSource: 5 })).status).toBe(422);
  });
});

describe("taxonomy", () => {
  beforeEach(async () => {
    await api.post("/api/projects", { id: "p", name: "P", taxonomy: { groups: SAMPLE_GROUPS } });
  });

  test("every PUT bumps the version", async () => {
    const first = await api.put("/api/projects/p/taxonomy", { groups: SAMPLE_GROUPS });
    expect(first.body.version).toBe(2);
    const second = await api.put("/api/projects/p/taxonomy", { version: 99, groups: SAMPLE_GROUPS });
    expect(second.body.version).toBe(3);
    expect((await api.get("/api/projects/p")).body.taxonomy.version).toBe(3);
  });

  test("adding and deprecating is allowed, removing a label is refused", async () => {
    const withExtra = structuredClone(SAMPLE_GROUPS);
    withExtra[1].labels.push({ id: "rope", name: "Rope" } as never);
    expect((await api.put("/api/projects/p/taxonomy", { groups: withExtra })).status).toBe(200);

    const deprecated = structuredClone(withExtra);
    (deprecated[1].labels[0] as { deprecated?: boolean }).deprecated = true;
    const deprecation = await api.put("/api/projects/p/taxonomy", { groups: deprecated });
    expect(deprecation.status).toBe(200);
    expect(deprecation.body.version).toBe(3);

    const removed = structuredClone(deprecated);
    removed[1].labels.shift();
    const refusal = await api.put("/api/projects/p/taxonomy", { groups: removed });
    expect(refusal.status).toBe(422);
    expect(refusal.body.errors[0]).toContain("extras.toy");
    expect(refusal.body.errors[0]).toContain("deprecated");
    expect((await api.get("/api/projects/p")).body.taxonomy.version).toBe(3);
  });

  test("removing a group is refused", async () => {
    const refusal = await api.put("/api/projects/p/taxonomy", { groups: [SAMPLE_GROUPS[0]] });
    expect(refusal.status).toBe(422);
    expect(refusal.body.errors.some((message: string) => message.includes('"extras"'))).toBe(true);
  });

  test("rule violations and malformed bodies answer 422", async () => {
    const twoHotkeys = structuredClone(SAMPLE_GROUPS);
    twoHotkeys[0].labels[1].hotkey = "d";
    expect((await api.put("/api/projects/p/taxonomy", { groups: twoHotkeys })).status).toBe(422);
    expect((await api.put("/api/projects/p/taxonomy", { groups: "nope" })).status).toBe(422);
    expect((await api.put("/api/projects/p/taxonomy", { groups: [{ id: "x" }] })).status).toBe(422);
    expect((await api.put("/api/projects/missing/taxonomy", { groups: [] })).status).toBe(404);
  });
});
