import fs from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import type { Project, ProjectConfig } from "@atlas/contracts";
import { makeTempDirectory, startHost, writeAtlasConfig } from "../../../tests/server/helpers";
import { regionPrimitives } from "../src/server";

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

function primitiveOf(id: string) {
  const primitive = regionPrimitives.find((candidate) => candidate.id === id);
  if (!primitive) {
    throw new Error(`missing primitive ${id}`);
  }
  return primitive;
}

test("rect is clamped to the unit square", () => {
  const result = primitiveOf("rect").normalize({ x: -0.2, y: 0.5, w: 2, h: 0.25, label: "a" }, project);
  expect(result).toEqual({ x: 0, y: 0.5, w: 1, h: 0.25, label: "a" });
});

test("rect cannot extend past the edge and must have area", () => {
  const rect = primitiveOf("rect");
  expect(rect.normalize({ x: 0.75, y: 0, w: 0.5, h: 1, label: "a" }, project)).toEqual({
    x: 0.75, y: 0, w: 0.25, h: 1, label: "a",
  });
  expect(rect.normalize({ x: 1, y: 0, w: 0.5, h: 0.5, label: "a" }, project)).toBeNull();
});

test("unknown labels and non-numeric coordinates are invalid", () => {
  const rect = primitiveOf("rect");
  expect(rect.normalize({ x: 0, y: 0, w: 0.5, h: 0.5, label: "nope" }, project)).toBeNull();
  expect(rect.normalize({ x: "0", y: 0, w: 0.5, h: 0.5, label: "a" }, project)).toBeNull();
  expect(rect.normalize({ x: Number.NaN, y: 0, w: 0.5, h: 0.5, label: "a" }, project)).toBeNull();
});

test("polygon clamps points and needs three of them", () => {
  const polygon = primitiveOf("polygon");
  const result = polygon.normalize({ points: [[-1, 0], [2, 0.5], [0.5, 0.5]], label: "b" }, project);
  expect(result).toEqual({ points: [[0, 0], [1, 0.5], [0.5, 0.5]], label: "b" });
  expect(polygon.normalize({ points: [[0, 0], [1, 1]], label: "b" }, project)).toBeNull();
  expect(polygon.normalize({ points: [[0, 0], [1, 1], ["x", 1]], label: "b" }, project)).toBeNull();
  expect(polygon.normalize({ points: [[0, 0], [1, 1], [0, 1, 1]], label: "b" }, project)).toBeNull();
});

test("keypoint clamps and validates the label", () => {
  const keypoint = primitiveOf("keypoint");
  expect(keypoint.normalize({ x: 3, y: -3, label: "a" }, project)).toEqual({ x: 1, y: 0, label: "a" });
  expect(keypoint.normalize({ x: 0.5, y: 0.5, label: "zzz" }, project)).toBeNull();
});

test("region primitives are not trainable", () => {
  for (const primitive of regionPrimitives) {
    expect(primitive.trainingLabels).toBeUndefined();
  }
});

test("plugin registers on load and unregisters when removed from atlas.json", async () => {
  const workspaceDirectory = makeTempDirectory();
  const packageDirectory = path.resolve(import.meta.dir, "..");
  const config = (plugins: unknown[]) => ({ title: "t", plugins, workflows: [], settings: {} });
  writeAtlasConfig(workspaceDirectory, config([{ package: "@atlas/plugin-primitive-region", path: packageDirectory }]));
  const host = await startHost(workspaceDirectory);
  for (const id of ["rect", "polygon", "keypoint"]) {
    expect(host.context.primitives.get(id)).toBeDefined();
  }
  writeAtlasConfig(workspaceDirectory, config([]));
  await host.context.plugins.reload();
  for (const id of ["rect", "polygon", "keypoint"]) {
    expect(host.context.primitives.get(id)).toBeUndefined();
  }
  await host.stop();
  fs.rmSync(workspaceDirectory, { recursive: true, force: true });
});
