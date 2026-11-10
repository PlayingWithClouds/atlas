import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Host } from "../../packages/server/src/index";
import { apiOf, itemPath, makeTempDirectory, seedProject, startHost, waitFor, writeAtlasConfig } from "./helpers";

interface FakeReceiver {
  url: string;
  received: any[];
  /** Answer 500 to this many upcoming requests. */
  failNext: number;
  attempts: number;
  holdResponses: boolean;
  stop(): void;
}

function startReceiver(): FakeReceiver {
  const receiver = { received: [], failNext: 0, attempts: 0, holdResponses: false } as unknown as FakeReceiver;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      receiver.attempts += 1;
      if (receiver.failNext > 0) {
        receiver.failNext -= 1;
        return new Response("down", { status: 500 });
      }
      if (receiver.holdResponses) {
        await Bun.sleep(300);
      }
      receiver.received.push(await request.json());
      return new Response("ok");
    },
  });
  receiver.url = `http://127.0.0.1:${server.port}/atlas`;
  receiver.stop = () => server.stop(true);
  return receiver;
}

const FAST_RETRIES = { firstRetryDelayMs: 5, maximumRetryDelayMs: 20, giveUpAfterMs: 400, requestTimeoutMs: 500 };
const labeled = { status: "labeled", values: { position: ["doggy"] }, reviewed: ["position"] };

let receiver: FakeReceiver;
let host: Host;

beforeEach(() => {
  receiver = startReceiver();
});
afterEach(async () => {
  await host.stop();
  receiver.stop();
});

async function startWithWebhooks(webhooks: unknown[]) {
  const workspaceDirectory = makeTempDirectory();
  writeAtlasConfig(workspaceDirectory, { title: "t", plugins: [], webhooks, tokens: [], settings: {} });
  host = await startHost(workspaceDirectory, { webhookTiming: FAST_RETRIES });
  const api = apiOf(host);
  const itemIds = await seedProject(api, 4, "scenes");
  return { api, itemIds };
}

const save = (api: ReturnType<typeof apiOf>, itemId: string) => api.put(`${itemPath("scenes", itemId)}/annotation`, labeled);

test("annotation events arrive in order with the change as payload", async () => {
  const { api, itemIds } = await startWithWebhooks([{ url: receiver.url, events: ["annotation"] }]);
  for (const itemId of itemIds) {
    await save(api, itemId);
  }
  await api.post("/api/projects/scenes/items/delete", { ids: [itemIds[0]] });
  await waitFor(() => receiver.received.length === 5);

  expect(receiver.received.map((event) => event.type)).toEqual(["annotation", "annotation", "annotation", "annotation", "annotation"]);
  expect(receiver.received.map((event) => event.change.itemId)).toEqual([...itemIds, itemIds[0]]);
  expect(receiver.received[0]).toMatchObject({ projectId: "scenes", change: { kind: "saved", annotation: { status: "labeled" } } });
  expect(receiver.received[4].change.kind).toBe("orphaned");
  const cursors = receiver.received.map((event) => Number(event.change.cursor));
  expect(cursors).toEqual([...cursors].sort((first, second) => first - second));
});

test("taxonomy changes are delivered with the new version", async () => {
  const { api } = await startWithWebhooks([{ url: receiver.url, events: ["taxonomy"] }]);
  const project = (await api.get("/api/projects/scenes")).body;
  await api.put("/api/projects/scenes/taxonomy", { groups: project.taxonomy.groups });
  await waitFor(() => receiver.received.length === 1);
  expect(receiver.received[0]).toMatchObject({ type: "taxonomy", projectId: "scenes", taxonomy: { version: 2 } });
});

test("events and project filters decide what a webhook receives", async () => {
  const { api, itemIds } = await startWithWebhooks([
    { url: receiver.url, project: "other", events: ["annotation"] },
    { url: receiver.url, project: "scenes", events: ["taxonomy"] },
  ]);
  await save(api, itemIds[0]);
  await Bun.sleep(100);
  expect(receiver.attempts).toBe(0);
});

test("a failing receiver is retried with backoff and keeps event order", async () => {
  const { api, itemIds } = await startWithWebhooks([{ url: receiver.url, events: ["annotation"] }]);
  receiver.failNext = 3;
  await save(api, itemIds[0]);
  await save(api, itemIds[1]);
  await waitFor(() => receiver.received.length === 2);
  expect(receiver.attempts).toBe(5);
  expect(receiver.received.map((event) => event.change.itemId)).toEqual([itemIds[0], itemIds[1]]);
});

test("a receiver that stays down is given up on, then later events are delivered", async () => {
  const { api, itemIds } = await startWithWebhooks([{ url: receiver.url, events: ["annotation"] }]);
  receiver.failNext = 1000;
  await save(api, itemIds[0]);
  await Bun.sleep(600);
  const attemptsWhenGivingUp = receiver.attempts;
  expect(attemptsWhenGivingUp).toBeGreaterThan(3);
  expect(receiver.received).toEqual([]);

  receiver.failNext = 0;
  await save(api, itemIds[1]);
  await waitFor(() => receiver.received.length === 1);
  expect(receiver.received[0].change.itemId).toBe(itemIds[1]);
  expect(receiver.attempts).toBe(attemptsWhenGivingUp + 1);
});

test("a slow or unreachable receiver never delays the request", async () => {
  const { api, itemIds } = await startWithWebhooks([
    { url: receiver.url, events: ["annotation"] },
    { url: "http://127.0.0.1:1/nowhere", events: ["annotation"] },
  ]);
  receiver.holdResponses = true;
  const startedAt = Date.now();
  const response = await save(api, itemIds[0]);
  expect(response.status).toBe(200);
  expect(Date.now() - startedAt).toBeLessThan(200);
});

test("a malformed webhook entry in atlas.json is ignored", async () => {
  const { api, itemIds } = await startWithWebhooks([{ url: 5 }, "nope", { url: receiver.url, events: ["annotation"] }]);
  await save(api, itemIds[0]);
  await waitFor(() => receiver.received.length === 1);
});
