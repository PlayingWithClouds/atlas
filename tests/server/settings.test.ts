import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Host } from "../../packages/server/src/index";
import { apiOf, makeTempDirectory, startHost } from "./helpers";
import type { Api } from "./helpers";

let host: Host;
let api: Api;
let directory: string;

beforeEach(async () => {
  directory = makeTempDirectory();
  host = await startHost(directory);
  api = apiOf(host);
});
afterEach(async () => {
  await host.stop();
});

describe("settings", () => {
  test("a scope reads {} until set, then what was put, kept in atlas.json", async () => {
    expect((await api.get("/api/settings/web")).body).toEqual({});
    const saved = await api.put("/api/settings/web", { leader: ";", seekSeconds: 3 });
    expect(saved.status).toBe(200);
    expect((await api.get("/api/settings/web")).body).toEqual({ leader: ";", seekSeconds: 3 });
    const config = JSON.parse(fs.readFileSync(path.join(directory, "atlas.json"), "utf8"));
    expect(config.settings.web).toEqual({ leader: ";", seekSeconds: 3 });
  });

  test("put replaces the scope and leaves other scopes and config alone", async () => {
    await api.put("/api/settings/other", { keep: true });
    await api.put("/api/settings/web", { leader: ";" });
    await api.put("/api/settings/web", { zoomStep: 2 });
    expect((await api.get("/api/settings/web")).body).toEqual({ zoomStep: 2 });
    expect((await api.get("/api/settings/other")).body).toEqual({ keep: true });
  });

  test("rejects non-objects and odd scope names", async () => {
    expect((await api.put("/api/settings/web", [1, 2])).status).toBe(400);
    expect((await api.get("/api/settings/Bad%20Scope")).status).toBe(404);
  });
});
