import fs from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { ensureWorkspace, starterConfig } from "../../packages/server/src/index";
import { makeTempDirectory, startHost, writeAtlasConfig } from "./helpers";

test("init writes the new shape and never overwrites", () => {
  const directory = makeTempDirectory();
  ensureWorkspace(directory);
  const configPath = path.join(directory, "atlas.json");
  expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({ title: "atlas", plugins: [], webhooks: [], tokens: [], settings: {} });
  fs.writeFileSync(configPath, "{}");
  ensureWorkspace(directory);
  expect(fs.readFileSync(configPath, "utf8")).toBe("{}");
  expect(starterConfig([{ package: "x" }]).plugins).toEqual([{ package: "x" }]);
});

test("an old config starts: workflows are ignored and new fields default", async () => {
  const directory = makeTempDirectory();
  writeAtlasConfig(directory, {
    title: "legacy",
    plugins: [{ package: "@atlas/plugin-core-nodes", path: "/gone/core-nodes", enabled: true }],
    workflows: [{ id: "old", name: "Old", graph: { nodes: [], edges: [] } }],
    settings: { assistant: { model: "x" } },
  });
  const host = await startHost(directory);
  const config = host.context.workspace.config();
  expect(config).toEqual({
    title: "legacy",
    plugins: [{ package: "@atlas/plugin-core-nodes", path: "/gone/core-nodes", enabled: true }],
    webhooks: [],
    tokens: [],
    settings: { assistant: { model: "x" } },
  });
  expect((config as unknown as Record<string, unknown>).workflows).toBeUndefined();
  expect((await fetch(`http://localhost:${host.context.http.port}/api/projects`)).status).toBe(200);
  await host.stop();
});

test("malformed fields fall back to defaults", async () => {
  const directory = makeTempDirectory();
  writeAtlasConfig(directory, { title: 3, plugins: "x", webhooks: [{ url: "http://a" }, 7], tokens: [{ name: "a", token: "" }, { name: "b", token: "t" }], settings: [] });
  const host = await startHost(directory);
  expect(host.context.workspace.config()).toEqual({ title: "atlas", plugins: [], webhooks: [], tokens: [{ name: "b", token: "t" }], settings: {} });
  await host.stop();
});
