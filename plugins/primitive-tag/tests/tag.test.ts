import fs from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import type { Project, ProjectConfig } from "@atlas/contracts";
import { makeTempDirectory, startHost, writeAtlasConfig } from "../../../tests/server/helpers";
import plugin, { normalizeTag, tagPrimitive } from "../src/server";

function projectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    mediaKind: "image",
    model: "fake-model",
    primitives: ["tag"],
    labels: { groups: [{ id: "g", label: "G", classes: [{ name: "a" }, { name: "b" }] }] },
    ...overrides,
  };
}


const project = { id: "p", name: "p", config: projectConfig() } as unknown as Project;

test("normalize keeps project classes only and dedupes", () => {
  const result = normalizeTag({ labels: ["a", "zzz", "b", "a", 5] }, project);
  expect(result).toEqual({ labels: ["a", "b"] });
});

test("normalize returns null when nothing valid remains", () => {
  expect(normalizeTag({ labels: ["zzz"] }, project)).toBeNull();
  expect(normalizeTag({ labels: [] }, project)).toBeNull();
  expect(normalizeTag({}, project)).toBeNull();
  expect(normalizeTag({ labels: "a" }, project)).toBeNull();
});

test("trainingLabels returns the labels", () => {
  expect(tagPrimitive.trainingLabels?.({ labels: ["a", "b"] })).toEqual(["a", "b"]);
});

function configWith(plugins: unknown[]) {
  return { title: "t", plugins, workflows: [], settings: {} };
}

test("plugin registers on load and unregisters when removed from atlas.json", async () => {
  const workspaceDirectory = makeTempDirectory();
  const packageDirectory = path.resolve(import.meta.dir, "..");
  expect(plugin.name).toBe("primitive-tag");
  writeAtlasConfig(workspaceDirectory, configWith([{ package: "@atlas/plugin-primitive-tag", path: packageDirectory }]));
  const host = await startHost(workspaceDirectory);
  expect(host.context.primitives.get("tag")).toBeDefined();

  writeAtlasConfig(workspaceDirectory, configWith([]));
  await host.context.plugins.reload();
  expect(host.context.primitives.get("tag")).toBeUndefined();
  await host.stop();
  fs.rmSync(workspaceDirectory, { recursive: true, force: true });
});
