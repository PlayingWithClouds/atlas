import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Fiber } from "@neoworks/extension-system";
import type { Project } from "@atlas/contracts";
import type { SourceProvider } from "@atlas/contracts/server";
import { fakeModel, fakePrimitive, mountProviders, projectConfig } from "../../../tests/server/fakes";
import type { FakeModelState } from "../../../tests/server/fakes";
import { makeTempDirectory, startHost, urlOf, waitFor } from "../../../tests/server/helpers";
import type { Host } from "../../../packages/server/src/index";
import ExporterFolder from "../src/server";

let host: Host;
let workspaceDirectory: string;
let sourceDirectory: string;
let fiber: Fiber;
let remote: ReturnType<typeof Bun.serve>;

const REMOTE_HEADER = "x-test-token";

/** Resolves refs as local paths, or as URLs on the fake remote server. */
function pathOrUrlSource(): SourceProvider {
  return {
    id: "fake-source",
    kinds: () => [],
    resolve: async () => ({ label: "x", items: [] }),
    locate: (ref) => {
      if (ref.startsWith("http")) {
        return { kind: "url", url: ref, headers: { [REMOTE_HEADER]: "secret" } };
      }
      return { kind: "file", path: ref };
    },
  };
}

beforeEach(async () => {
  workspaceDirectory = makeTempDirectory();
  sourceDirectory = makeTempDirectory("atlas-export-src-");
  remote = Bun.serve({
    port: 0,
    fetch(request) {
      if (request.headers.get(REMOTE_HEADER) !== "secret") {
        return new Response("forbidden", { status: 403 });
      }
      return new Response("remote-bytes", { headers: { "content-type": "image/png" } });
    },
  });
  host = await startHost(workspaceDirectory);
  const state: FakeModelState = { trained: [], failTraining: false, rankOrder: [], forgotten: [], predictions: {} };
  await mountProviders(host, { model: fakeModel(state), primitive: fakePrimitive, source: pathOrUrlSource() });
  fiber = host.context.plugin(ExporterFolder as never, {} as never);
  await fiber;
});

afterEach(async () => {
  remote.stop(true);
  await host.stop();
  fs.rmSync(workspaceDirectory, { recursive: true, force: true });
  fs.rmSync(sourceDirectory, { recursive: true, force: true });
});

function writeSourceFile(name: string, content: string): string {
  const filePath = path.join(sourceDirectory, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function labelItems(project: Project): void {
  const { items } = host.context;
  const session = items.createSession({
    projectId: project.id,
    label: "origin",
    source: { plugin: "fake-source", kind: "k", params: {} },
  });
  const created = items.append(session.id, [
    { ref: writeSourceFile("one.jpg", "bytes-one"), mediaKind: "fake-media" },
    { ref: `http://localhost:${remote.port}/pic`, mediaKind: "fake-media" },
    { ref: path.join(sourceDirectory, "missing.jpg"), mediaKind: "fake-media" },
    { ref: "clip.mp4", mediaKind: "fake-media", span: { start: 1, end: 2 } },
    { ref: writeSourceFile("unlabeled.jpg", "nope"), mediaKind: "fake-media" },
  ]);
  const annotation = (name: string) => [{ type: "fake-tag", value: { classes: [name] } }];
  items.setAnnotations(created[0].id, annotation("a"), "labeled");
  items.setAnnotations(created[1].id, annotation("b"), "labeled");
  items.setAnnotations(created[2].id, annotation("a"), "labeled");
  items.setAnnotations(created[3].id, annotation("a"), "labeled");
}

async function post(pathname: string, body: unknown): Promise<Response> {
  return fetch(urlOf(host, pathname), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function finishedJob(jobId: string) {
  await waitFor(() => host.context.jobs.get(jobId)?.state !== "running");
  return host.context.jobs.get(jobId)!;
}

test("export then import round-trips labels into a new session", async () => {
  const project = host.context.projects.create("p", projectConfig());
  labelItems(project);
  const exportDirectory = path.join(workspaceDirectory, "out");

  const exported = await post(`/api/projects/${project.id}/export`, { path: exportDirectory });
  const exportJob = await finishedJob(((await exported.json()) as { job: { id: string } }).job.id);
  expect(exportJob.state).toBe("done");
  expect(exportJob.extra).toMatchObject({ exported: 2, skippedSpans: 1, skippedFailed: 1 });

  expect(fs.readdirSync(exportDirectory).sort()).toEqual(["000000.jpg", "000001.png", "dataset.json", "labels.json"]);
  expect(fs.readFileSync(path.join(exportDirectory, "000000.jpg"), "utf8")).toBe("bytes-one");
  expect(fs.readFileSync(path.join(exportDirectory, "000001.png"), "utf8")).toBe("remote-bytes");
  const dataset = JSON.parse(fs.readFileSync(path.join(exportDirectory, "dataset.json"), "utf8"));
  expect(dataset).toMatchObject({ count: 2, skipped: 2, classes: ["a", "b"], project: { id: project.id } });

  const imported = await post(`/api/projects/${project.id}/import`, { path: exportDirectory });
  const importJob = await finishedJob(((await imported.json()) as { job: { id: string } }).job.id);
  expect(importJob.state).toBe("done");

  const sessions = host.context.items.listSessions(project.id).filter((session) => session.source.plugin === "exporter-folder");
  expect(sessions).toHaveLength(1);
  expect(sessions[0].source).toEqual({ plugin: "exporter-folder", kind: "import", params: { path: exportDirectory } });
  const importedItems = host.context.items.list(sessions[0].id);
  expect(importedItems.map((item) => item.status)).toEqual(["labeled", "labeled"]);
  expect(importedItems.map((item) => item.annotations[0].value.classes)).toEqual([["a"], ["b"]]);
  expect(importedItems[0].mediaKind).toBe("fake-media");

  const location = await host.context.sources.locate(importedItems[0]);
  expect(location).toMatchObject({ kind: "file" });
});

test("default export path lives under the workspace exports folder", async () => {
  const project = host.context.projects.create("p", projectConfig());
  const response = await post(`/api/projects/${project.id}/export`, {});
  const body = (await response.json()) as { directory: string; job: { id: string } };
  expect(body.directory.startsWith(path.join(workspaceDirectory, "exports", `${project.id}-`))).toBe(true);
  expect((await finishedJob(body.job.id)).state).toBe("done");
  expect(fs.existsSync(path.join(body.directory, "labels.json"))).toBe(true);
});

test("routes reject unknown projects and bad import folders", async () => {
  const project = host.context.projects.create("p", projectConfig());
  expect((await post("/api/projects/nope/export", {})).status).toBe(404);
  expect((await post(`/api/projects/${project.id}/import`, {})).status).toBe(400);
  const empty = makeTempDirectory("atlas-empty-");
  expect((await post(`/api/projects/${project.id}/import`, { path: empty })).status).toBe(404);
  fs.rmSync(empty, { recursive: true, force: true });
});

test("locate only serves files inside folders that were imported", async () => {
  const provider = host.context.sources.get("exporter-folder")!;
  const dataset = makeTempDirectory("atlas-dataset-");
  fs.writeFileSync(path.join(dataset, "000000.jpg"), "x");
  fs.writeFileSync(path.join(dataset, "labels.json"), JSON.stringify({ "000000.jpg": [], "../escape.jpg": [] }));
  const outside = writeSourceFile("secret.txt", "secret");
  try {
    expect(() => provider.locate(path.join(dataset, "000000.jpg"))).toThrow();
    const resolved = await provider.resolve("import", { path: dataset, mediaKind: "fake-media" });
    expect(resolved.items.map((item) => item.ref)).toEqual([path.join(dataset, "000000.jpg")]);
    expect(await provider.locate(resolved.items[0].ref)).toMatchObject({ kind: "file" });
    expect(() => provider.locate(outside)).toThrow();
  } finally {
    fs.rmSync(dataset, { recursive: true, force: true });
  }
});

test("lifecycle: dispose withdraws the source and the routes", async () => {
  expect(host.context.sources.get("exporter-folder")).toBeDefined();
  const project = host.context.projects.create("p", projectConfig());
  await fiber.dispose();
  expect(host.context.sources.get("exporter-folder")).toBeUndefined();
  expect((await post(`/api/projects/${project.id}/export`, {})).status).toBe(404);
});
