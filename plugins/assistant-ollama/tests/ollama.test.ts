import fs from "node:fs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { FiberState } from "@neoworks/extension-system";
import type { Tool } from "@atlas/contracts/server";
import type { AssistantEvent, AssistantMessage, AssistantTurn } from "@atlas/plugin-assistant/types";
import { makeTempDirectory, startHost, waitFor } from "../../../tests/server/helpers";
import type { Host } from "../../../packages/server/src/index";
import Assistant from "../../assistant/src/server";
import { OllamaClient } from "../src/client";
import { resolveConfig } from "../src/config";
import { fillContext, forHistory, runTurn, toolDefinitions } from "../src/loop";
import type { LoopDependencies } from "../src/loop";
import { systemPrompt } from "../src/prompt";
import Ollama from "../src/server";

type ScriptedReply = Partial<AssistantMessage> & { delayMs?: number };

/** Answers each /api/chat with the next scripted reply and records what it was asked. */
class FakeOllama {
  replies: ScriptedReply[];
  chatRequests: Record<string, any>[] = [];
  showRequests = 0;
  capabilities: string[] = ["completion", "tools"];
  failShowTimes = 0;
  server: ReturnType<typeof Bun.serve>;

  constructor(replies: ScriptedReply[] = []) {
    this.replies = replies;
    this.server = Bun.serve({ port: 0, fetch: (request) => this.handle(request) });
  }

  get url(): string {
    return `http://localhost:${this.server.port}`;
  }

  private async handle(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/show") {
      return this.handleShow();
    }
    const body = (await request.json()) as Record<string, any>;
    this.chatRequests.push(body);
    const reply = this.replies.shift() ?? { role: "assistant", content: "(no script left)" };
    if (reply.delayMs !== undefined) {
      await Bun.sleep(reply.delayMs);
    }
    const { delayMs: _delay, ...message } = reply;
    return Response.json({ message: { role: "assistant", content: "", ...message }, done: true });
  }

  private handleShow(): Response {
    this.showRequests += 1;
    if (this.failShowTimes > 0) {
      this.failShowTimes -= 1;
      return new Response("nope", { status: 500 });
    }
    return Response.json({ capabilities: this.capabilities });
  }
}

let host: Host;
let workspaceDirectory: string;
let fake: FakeOllama;

beforeEach(async () => {
  workspaceDirectory = makeTempDirectory();
  host = await startHost(workspaceDirectory);
  fake = new FakeOllama();
});

afterEach(async () => {
  fake.server.stop(true);
  await host.stop();
  fs.rmSync(workspaceDirectory, { recursive: true, force: true });
});

function fakeTool(name: string, overrides: Partial<Tool> = {}): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {}, required: [] },
    readOnly: true,
    async run() {
      return [{ type: "text", text: `${name} result` }];
    },
    ...overrides,
  };
}

function toolCall(name: string, args: Record<string, unknown> = {}): ScriptedReply {
  return { tool_calls: [{ function: { name, arguments: args } }] };
}

function dependencies(overrides: Record<string, unknown> = {}): LoopDependencies {
  const config = resolveConfig({ url: fake.url, model: "test-model", visionModel: "test-vision", maxToolCalls: 8, ...overrides });
  return { ctx: host.context, client: new OllamaClient(config.url), config };
}

async function runWith(loop: LoopDependencies, turn: Partial<AssistantTurn> = {}) {
  const events: AssistantEvent[] = [];
  const produced = await runTurn(loop, { messages: [], ...turn }, (event) => events.push(event), new AbortController().signal);
  return { events, produced };
}

function kindsOf(events: AssistantEvent[]): string {
  return events.map((event) => event.kind).join(",");
}

test("a plain answer needs no tools", async () => {
  fake.replies = [{ content: "Label the uncertain items first." }];
  const { events, produced } = await runWith(dependencies(), { messages: [{ role: "user", content: "what next?" }] });
  expect(events).toEqual([{ kind: "message", content: "Label the uncertain items first." }]);
  expect(produced).toHaveLength(1);
  expect(fake.chatRequests[0].model).toBe("test-model");
  expect(fake.chatRequests[0].messages[0].role).toBe("system");
});

test("a tool result flows back into the conversation", async () => {
  host.context.tools.register(fakeTool("list_workflows"));
  fake.replies = [toolCall("list_workflows"), { content: "There are none." }];
  const { events } = await runWith(dependencies());
  expect(kindsOf(events)).toBe("tool,tool_result,message");
  expect(events[1].detail).toBe("list_workflows result");
  expect(fake.chatRequests).toHaveLength(2);
  const replayed = fake.chatRequests[1].messages;
  expect(replayed[replayed.length - 1]).toEqual({ role: "tool", tool_name: "list_workflows", content: "list_workflows result" });
});

test("a failing tool is handed back to the model instead of ending the turn", async () => {
  fake.replies = [toolCall("teleport"), { content: "No such tool." }];
  const { events } = await runWith(dependencies());
  expect(kindsOf(events)).toBe("tool,tool_result,message");
  expect(events[1].detail).toContain("unknown tool");
});

test("a tool that throws is recovered", async () => {
  host.context.tools.register(
    fakeTool("explode", {
      async run() {
        throw new Error("kaboom");
      },
    }),
  );
  fake.replies = [toolCall("explode"), { content: "It failed." }];
  const { events } = await runWith(dependencies());
  expect(kindsOf(events)).toBe("tool,tool_result,message");
  expect(events[1].detail).toBe("error: kaboom");
});

test("string tool arguments from the model are parsed", async () => {
  let received: Record<string, unknown> = {};
  host.context.tools.register(
    fakeTool("echo", {
      async run(args) {
        received = args;
        return [{ type: "text", text: "ok" }];
      },
    }),
  );
  fake.replies = [{ tool_calls: [{ function: { name: "echo", arguments: '{"word":"hi"}' as never } }] }, { content: "done" }];
  await runWith(dependencies());
  expect(received).toEqual({ word: "hi" });
});

test("looping is bounded", async () => {
  host.context.tools.register(fakeTool("list_workflows"));
  fake.replies = [toolCall("list_workflows"), toolCall("list_workflows"), toolCall("list_workflows")];
  const { events } = await runWith(dependencies({ maxToolCalls: 2 }));
  const last = events[events.length - 1];
  expect(last.kind).toBe("error");
  expect(last.content).toContain("may be looping");
  expect(fake.chatRequests).toHaveLength(2);
});

test("thinking is only requested from models that support it", async () => {
  fake.replies = [{ content: "done" }];
  await runWith(dependencies());
  expect(fake.chatRequests[0].think).toBeUndefined();

  const capable = new FakeOllama([{ content: "done" }]);
  capable.capabilities = ["completion", "tools", "thinking"];
  const config = resolveConfig({ url: capable.url, model: "test-model" });
  await runTurn({ ctx: host.context, client: new OllamaClient(config.url), config }, { messages: [] }, () => {}, new AbortController().signal);
  expect(capable.chatRequests[0].think).toBe(true);
  capable.server.stop(true);
});

test("capabilities are cached per model, but failed probes are not", async () => {
  fake.capabilities = ["completion", "tools", "thinking"];
  fake.failShowTimes = 1;
  fake.replies = [{ content: "one" }, { content: "two" }, { content: "three" }];
  const loop = dependencies();
  await runWith(loop);
  expect(fake.chatRequests[0].think).toBeUndefined();
  await runWith(loop);
  expect(fake.chatRequests[1].think).toBe(true);
  await runWith(loop);
  expect(fake.showRequests).toBe(2);
});

test("thinking is surfaced and replayed only on tool turns", async () => {
  host.context.tools.register(fakeTool("list_workflows"));
  fake.capabilities = ["completion", "tools", "thinking"];
  fake.replies = [
    { ...toolCall("list_workflows"), thinking: "I should look at the workflows first." },
    { content: "There are none.", thinking: "Nothing came back." },
  ];
  const { events, produced } = await runWith(dependencies());
  expect(kindsOf(events)).toBe("thinking,tool,tool_result,thinking,message");
  const assistantTurns = fake.chatRequests[1].messages.filter((message: AssistantMessage) => message.role === "assistant");
  expect(assistantTurns).toHaveLength(1);
  expect(assistantTurns[0].thinking).toBe("I should look at the workflows first.");
  expect(produced[produced.length - 1].thinking).toBeUndefined();
});

test("forHistory keeps reasoning only when a tool was called", () => {
  const withTool = { role: "assistant", content: "", thinking: "why", tool_calls: [{ function: { name: "x", arguments: {} } }] } as AssistantMessage;
  expect(forHistory(withTool).thinking).toBe("why");
  expect(forHistory({ role: "assistant", content: "a", thinking: "why" }).thinking).toBeUndefined();
});

test("reasoning without an answer says so", async () => {
  fake.capabilities = ["thinking"];
  fake.replies = [{ content: "", thinking: "hmm, well, hmm" }];
  const { events } = await runWith(dependencies());
  expect(events[events.length - 1].content).toContain("never wrote an answer");
});

test("an empty reply is reported rather than rendered", async () => {
  fake.replies = [{ content: "   " }];
  const { events } = await runWith(dependencies());
  expect(kindsOf(events)).toBe("error");
  expect(events[0].content).toContain("empty answer");
});

test("an unreachable ollama ends the turn with a message", async () => {
  const { events } = await runWith(dependencies({ url: "http://127.0.0.1:1" }));
  expect(kindsOf(events)).toBe("error");
  expect(events[0].content).toContain("ollama unreachable");
});

test("an ollama error body ends the turn with its message", async () => {
  fake.server.stop(true);
  fake.server = Bun.serve({ port: 0, fetch: () => Response.json({ error: "model not found" }) });
  const { events } = await runWith(dependencies({ url: fake.url }));
  expect(events[0].content).toBe("ollama: model not found");
});

test("aborting stops the turn without an error event", async () => {
  fake.replies = [{ content: "slow", delayMs: 500 }];
  const controller = new AbortController();
  const events: AssistantEvent[] = [];
  const running = runTurn(dependencies(), { messages: [] }, (event) => events.push(event), controller.signal);
  await waitFor(() => fake.chatRequests.length === 1);
  controller.abort();
  await running;
  expect(events).toEqual([]);
});

test("session and project fill in where the tool declares them, and the model's own value wins", () => {
  const schema = { properties: { sessionId: { type: "string" }, projectId: { type: "string" } } };
  const args: Record<string, unknown> = {};
  fillContext(args, schema, { messages: [], sessionId: "s1", projectId: "p1" });
  expect(args).toEqual({ sessionId: "s1", projectId: "p1" });

  const own: Record<string, unknown> = { sessionId: "other" };
  fillContext(own, schema, { messages: [], sessionId: "s1" });
  expect(own.sessionId).toBe("other");

  const unrelated: Record<string, unknown> = {};
  fillContext(unrelated, { properties: {} }, { messages: [], sessionId: "s1" });
  expect(unrelated).toEqual({});
});

test("the turn's session reaches a tool that omits it", async () => {
  let received: Record<string, unknown> = {};
  let receivedContext: Record<string, unknown> = {};
  host.context.tools.register(
    fakeTool("get_session", {
      inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: [] },
      async run(args, context) {
        received = args;
        receivedContext = context;
        return [{ type: "text", text: "ok" }];
      },
    }),
  );
  fake.replies = [toolCall("get_session"), { content: "done" }];
  await runWith(dependencies(), { sessionId: "s1", projectId: "p1" });
  expect(received).toEqual({ sessionId: "s1" });
  expect(receivedContext).toEqual({ projectId: "p1", sessionId: "s1" });
});

test("only the read-and-propose surface is offered and callable", async () => {
  host.context.tools.register(fakeTool("list_things"));
  host.context.tools.register(fakeTool("propose_labels", { readOnly: false }));
  host.context.tools.register(fakeTool("save_workflow", { readOnly: false }));
  let ran = false;
  host.context.tools.register(
    fakeTool("delete_everything", {
      readOnly: false,
      async run() {
        ran = true;
        return [];
      },
    }),
  );
  const names = toolDefinitions(host.context, dependencies().config).map((definition) => definition.function.name);
  expect(names).toEqual(["list_things", "propose_labels", "save_workflow"].sort());

  fake.replies = [toolCall("delete_everything"), { content: "ok" }];
  const { events } = await runWith(dependencies());
  expect(events[1].detail).toContain("unknown tool");
  expect(ran).toBe(false);
});

test("look_at_session exists only with a vision model and a contact sheet tool", () => {
  const withVision = dependencies().config;
  const withoutVision = dependencies({ visionModel: "" }).config;
  const names = (config: typeof withVision) => toolDefinitions(host.context, config).map((definition) => definition.function.name);

  expect(names(withVision)).not.toContain("look_at_session");
  host.context.tools.register(fakeTool("contact_sheet"));
  expect(names(withVision)).toContain("look_at_session");
  expect(names(withoutVision)).not.toContain("look_at_session");
});

test("look_at_session has the vision model describe the contact sheet", async () => {
  let sheetArguments: Record<string, unknown> = {};
  host.context.tools.register(
    fakeTool("contact_sheet", {
      async run(args) {
        sheetArguments = args;
        return [
          { type: "text", text: JSON.stringify({ columns: 6, total: 30, from: 4, tiles: [{}, {}, {}] }) },
          { type: "image", data: "SHEETBYTES", mimeType: "image/jpeg" },
        ];
      },
    }),
  );
  fake.replies = [
    toolCall("look_at_session", { sessionId: "s1", from: 4, question: "What is shown?" }),
    { content: "A mix of scenes." }, // vision model
    { content: "Mostly varied." },
  ];
  const { events } = await runWith(dependencies());
  expect(sheetArguments).toEqual({ sessionId: "s1", from: 4 });
  expect(events[1].detail).toBe("Looked at 3 of 30 items (from position 4): A mix of scenes.");
  const visionRequest = fake.chatRequests[1];
  expect(visionRequest.model).toBe("test-vision");
  expect(visionRequest.messages[0].images).toEqual(["SHEETBYTES"]);
  expect(visionRequest.messages[0].content).toContain("What is shown?");
  expect(visionRequest.messages[0].content).toContain("3 thumbnails");
  expect(visionRequest.tools).toBeUndefined();
});

test("the system prompt states the limits and stays generic", () => {
  const prompt = systemPrompt({ sessionId: "abc123", projectId: "proj", canLook: true });
  for (const phrase of ["cannot label", "abc123", "proj", "look_at_session", "dry_run_workflow", "general-purpose"]) {
    expect(prompt).toContain(phrase);
  }
  expect(systemPrompt({ canLook: false })).not.toContain("look_at_session");
});

test("the model is required and there is no default", () => {
  expect(() => resolveConfig({})).toThrow("model");
  expect(() => resolveConfig({ model: "  " })).toThrow("model");
  const resolved = resolveConfig({ model: "m" });
  expect(resolved.url).toBe("http://localhost:11434");
  expect(resolved.maxToolCalls).toBe(8);
  expect(resolved.visionModel).toBeUndefined();
});

test("a plugin mounted without a model fails", async () => {
  await host.context.plugin(Assistant as never, {} as never);
  const fiber = host.context.plugin(Ollama as never, {} as never);
  await expect(fiber.then(() => undefined)).rejects.toThrow("model");
  expect(fiber.state).toBe(FiberState.FAILED);
});

test("the backend registers while mounted, streams through the assistant route and unloads", async () => {
  await host.context.plugin(Assistant as never, {} as never);
  const fiber = host.context.plugin(Ollama as never, { url: fake.url, model: "test-model" } as never);
  await fiber;
  expect(host.context.assistantBackends.list().map((backend) => backend.id)).toEqual(["ollama"]);

  fake.replies = [{ content: "hello" }];
  const response = await fetch(`http://localhost:${host.context.http.port}/api/assistant/chat`, {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const frames = (await response.text()).split("\n\n").filter((frame) => frame !== "");
  const events = frames.map((frame) => JSON.parse(frame.slice("data: ".length)) as AssistantEvent);
  expect(events.map((event) => event.kind)).toEqual(["message", "done"]);
  expect(JSON.parse(events[1].content as string)).toHaveLength(1);

  await fiber.dispose();
  expect(host.context.assistantBackends.list()).toEqual([]);
});
