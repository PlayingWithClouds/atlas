import fs from "node:fs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { FiberState } from "@neoworks/extension-system";
import type { Fiber } from "@neoworks/extension-system";
import { makeTempDirectory, startHost, urlOf, waitFor } from "../../../tests/server/helpers";
import type { Host } from "../../../packages/server/src/index";
import { createBackendRegistry } from "../src/registry";
import Assistant from "../src/server";
import type { AssistantBackend, AssistantEvent, AssistantTurn } from "../src/types";

let host: Host;
let workspaceDirectory: string;
let fiber: Fiber;

beforeEach(async () => {
  workspaceDirectory = makeTempDirectory();
  host = await startHost(workspaceDirectory);
  fiber = host.context.plugin(Assistant as never, {} as never);
  await fiber;
});

afterEach(async () => {
  await host.stop();
  fs.rmSync(workspaceDirectory, { recursive: true, force: true });
});

function scriptedBackend(id: string, events: AssistantEvent[], received: AssistantTurn[] = []): AssistantBackend {
  return {
    id,
    label: `Backend ${id}`,
    async chat(turn, emit) {
      received.push(turn);
      for (const event of events) {
        emit(event);
      }
    },
  };
}

async function postChat(body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(urlOf(host, "/api/assistant/chat"), { method: "POST", body: JSON.stringify(body), signal });
}

function parseFrames(text: string): AssistantEvent[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.trim() !== "")
    .map((frame) => {
      expect(frame.startsWith("data: ")).toBe(true);
      return JSON.parse(frame.slice("data: ".length)) as AssistantEvent;
    });
}

test("the describe route reports no backends until one registers", async () => {
  const before = (await (await fetch(urlOf(host, "/api/assistant"))).json()) as any;
  expect(before.enabled).toBe(false);
  expect(before.backends).toEqual([]);

  host.context.assistantBackends.register(scriptedBackend("fake", []));
  host.context.tools.register({
    name: "list_things",
    description: "lists things",
    inputSchema: { type: "object", properties: {}, required: [] },
    readOnly: true,
    run: async () => [],
  });
  const after = (await (await fetch(urlOf(host, "/api/assistant"))).json()) as any;
  expect(after.enabled).toBe(true);
  expect(after.backends).toEqual([{ id: "fake", label: "Backend fake" }]);
  expect(after.defaultBackend).toBe("fake");
  expect(after.tools).toEqual([{ name: "list_things", description: "lists things" }]);
});

test("a turn streams one SSE frame per event and ends with done", async () => {
  const received: AssistantTurn[] = [];
  host.context.assistantBackends.register(
    scriptedBackend("fake", [{ kind: "tool", tool: "list_sessions", detail: "" }, { kind: "message", content: "hello" }], received),
  );
  const response = await postChat({
    messages: [{ role: "user", content: "hi" }],
    projectId: "p1",
    sessionId: "s1",
    session: "resume-1",
  });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const events = parseFrames(await response.text());
  expect(events.map((event) => event.kind)).toEqual(["tool", "message", "done"]);
  expect(received[0]).toEqual({
    messages: [{ role: "user", content: "hi" }],
    projectId: "p1",
    sessionId: "s1",
    session: "resume-1",
  });
});

test("a backend that sends its own done is not followed by a second one", async () => {
  host.context.assistantBackends.register(scriptedBackend("fake", [{ kind: "done", content: '[{"role":"assistant","content":"x"}]' }]));
  const events = parseFrames(await (await postChat({ messages: [] })).text());
  expect(events).toHaveLength(1);
  expect(events[0].content).toContain("assistant");
});

test("a throwing backend becomes an error event and the stream still ends", async () => {
  host.context.assistantBackends.register({
    id: "broken",
    label: "Broken",
    async chat() {
      throw new Error("kaboom");
    },
  });
  const events = parseFrames(await (await postChat({ messages: [] })).text());
  expect(events.map((event) => event.kind)).toEqual(["error", "done"]);
  expect(events[0].content).toBe("kaboom");
});

test("the backend field picks a backend and unknown ids are rejected", async () => {
  host.context.assistantBackends.register(scriptedBackend("first", [{ kind: "message", content: "from first" }]));
  host.context.assistantBackends.register(scriptedBackend("second", [{ kind: "message", content: "from second" }]));
  const chosen = parseFrames(await (await postChat({ messages: [], backend: "second" })).text());
  expect(chosen[0].content).toBe("from second");
  const fallback = parseFrames(await (await postChat({ messages: [] })).text());
  expect(fallback[0].content).toBe("from first");
  const unknown = await postChat({ messages: [], backend: "nope" });
  expect(unknown.status).toBe(400);
});

test("requests without a backend or with a bad body fail cleanly", async () => {
  expect((await postChat({ messages: [] })).status).toBe(404);
  host.context.assistantBackends.register(scriptedBackend("fake", []));
  expect((await postChat({ nothing: true })).status).toBe(400);
  const garbage = await fetch(urlOf(host, "/api/assistant/chat"), { method: "POST", body: "{oh no" });
  expect(garbage.status).toBe(400);
});

test("a client disconnect aborts the backend", async () => {
  let observedSignal: AbortSignal | undefined;
  host.context.assistantBackends.register({
    id: "slow",
    label: "Slow",
    async chat(_turn, emit, signal) {
      observedSignal = signal;
      emit({ kind: "thinking", content: "working" });
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    },
  });
  const controller = new AbortController();
  const response = await postChat({ messages: [] }, controller.signal);
  const reader = response.body!.getReader();
  await reader.read();
  controller.abort();
  await waitFor(() => observedSignal !== undefined && observedSignal.aborted);
});

test("backends registered by other plugins are withdrawn when they unload", async () => {
  const backendPlugin = {
    name: "fake-backend",
    inject: ["assistantBackends"],
    apply(ctx: any) {
      ctx.effect(() => ctx.assistantBackends.register(scriptedBackend("fake", [])), "backend:fake");
    },
  };
  const backendFiber = host.context.plugin(backendPlugin as never, {} as never);
  await backendFiber;
  expect(host.context.assistantBackends.list().map((backend) => backend.id)).toEqual(["fake"]);
  await backendFiber.dispose();
  expect(host.context.assistantBackends.list()).toEqual([]);
});

test("disposing the plugin removes its routes and returns dependents to pending", async () => {
  const backendPlugin = {
    name: "fake-backend",
    inject: ["assistantBackends"],
    apply(ctx: any) {
      ctx.effect(() => ctx.assistantBackends.register(scriptedBackend("fake", [])), "backend:fake");
    },
  };
  const backendFiber = host.context.plugin(backendPlugin as never, {} as never);
  await backendFiber;
  await fiber.dispose();
  expect((await fetch(urlOf(host, "/api/assistant"))).status).toBe(404);
  expect((await postChat({ messages: [] })).status).toBe(404);
  expect(backendFiber.state).toBe(FiberState.PENDING);
});

test("the registry rejects duplicate ids and returns disposers", () => {
  const registry = createBackendRegistry();
  const backend = scriptedBackend("a", []);
  const dispose = registry.register(backend);
  expect(() => registry.register(scriptedBackend("a", []))).toThrow();
  dispose();
  expect(registry.get("a")).toBeUndefined();
});
