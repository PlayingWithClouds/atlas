import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Host } from "../../packages/server/src/index";
import { apiOf, itemPath, seedProject, startHost, waitFor } from "./helpers";
import type { Api } from "./helpers";

let host: Host;
let api: Api;
let socket: WebSocket;
let messages: any[];

beforeEach(async () => {
  host = await startHost();
  api = apiOf(host);
  messages = [];
  socket = new WebSocket(`ws://localhost:${host.context.http.port}/api/live`);
  socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
  await new Promise((resolve) => (socket.onopen = resolve));
  await waitFor(() => messages.length > 0);
  messages.length = 0;
});
afterEach(async () => {
  socket.close();
  await host.stop();
});

const ofType = (type: string) => messages.filter((message) => message.type === type);

test("project creation announces the project list", async () => {
  await api.post("/api/projects", { id: "p", name: "P" });
  await waitFor(() => ofType("projects").length > 0);
});

test("item and suggestion pushes announce the affected ids", async () => {
  const itemIds = await seedProject(api, 2, "p");
  await waitFor(() => ofType("items").length > 0);
  expect(ofType("items")[0]).toEqual({ type: "items", projectId: "p", ids: itemIds });

  await api.post("/api/projects/p/suggestions", [{ itemId: itemIds[0], source: "probe", priority: 1 }]);
  await waitFor(() => ofType("suggestions").length > 0);
  expect(ofType("suggestions")[0]).toEqual({ type: "suggestions", projectId: "p", ids: [itemIds[0]] });
});

test("annotation saves and taxonomy changes are broadcast", async () => {
  const itemIds = await seedProject(api, 1, "p");
  await api.put(`${itemPath("p", itemIds[0])}/annotation`, { status: "skipped", values: {}, reviewed: [] });
  await waitFor(() => ofType("annotation").length > 0);
  expect(ofType("annotation")[0]).toMatchObject({ projectId: "p", change: { itemId: itemIds[0], kind: "saved" } });

  const project = (await api.get("/api/projects/p")).body;
  await api.put("/api/projects/p/taxonomy", { groups: project.taxonomy.groups });
  await waitFor(() => ofType("taxonomy").length > 0);
  expect(ofType("taxonomy")[0]).toMatchObject({ projectId: "p", taxonomy: { version: 2 } });
});

test("a rejected write broadcasts nothing", async () => {
  const itemIds = await seedProject(api, 1, "p");
  await Bun.sleep(50);
  messages.length = 0;
  await api.put(`${itemPath("p", itemIds[0])}/annotation`, { status: "labeled", values: { nope: [] }, reviewed: [] });
  await Bun.sleep(100);
  expect(ofType("annotation")).toEqual([]);
});
