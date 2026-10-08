import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AssistantEvent, AssistantTurn } from "@atlas/plugin-assistant/types";
import { makeTempDirectory, startHost, waitFor } from "../../../tests/server/helpers";
import type { Host } from "../../../packages/server/src/index";
import Assistant from "../../assistant/src/server";
import { buildClaudeArguments, claudeSystemPrompt, mcpConfigJson } from "../src/arguments";
import { createClaudeBackend } from "../src/backend";
import { DEFAULT_ALLOWED_TOOLS, DEFAULT_TOOLS, resolveConfig } from "../src/config";
import type { ClaudeConfig } from "../src/config";
import { ProcessTracker, spawnWithBun } from "../src/runner";
import type { ClaudeProcess, SpawnClaude, SpawnOptions } from "../src/runner";
import { ClaudeStreamTranslator, readClaudeStream, resultText, tail } from "../src/stream";
import { createClaudePlugin } from "../src/server";

// One turn that thought, called a tool and then answered.
const STREAM = [
  '{"type":"system","subtype":"init","session_id":"abc-123","tools":["Bash"]}',
  '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"check the session first"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call_1","name":"mcp__atlas__list_items","input":{"sessionId":"s1","status":"pending"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"{\\"total\\":12}"}]}]}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"12 items are still pending."}]}}',
  '{"type":"result","subtype":"success","is_error":false,"session_id":"abc-123","result":"12 items are still pending."}',
].join("\n");

function translate(input: string) {
  const events: AssistantEvent[] = [];
  const translator = new ClaudeStreamTranslator((event) => events.push(event));
  for (const line of input.split("\n")) {
    translator.pushLine(line);
  }
  return { events, outcome: translator.outcome };
}

const launch = { mcpUrl: "http://127.0.0.1:8123/api/mcp", workspaceDirectory: "/tmp/workspace" };

function argumentsFor(config: ClaudeConfig = {}, turn: Partial<AssistantTurn> = {}): string[] {
  return buildClaudeArguments(resolveConfig(config), { messages: [], ...turn }, launch);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

test("the stream is translated into page events", () => {
  const { events, outcome } = translate(STREAM);
  expect(events.map((event) => event.kind)).toEqual(["session", "thinking", "tool", "tool_result", "message"]);
  expect(events[0].session).toBe("abc-123");
  expect(events[2].tool).toBe("mcp__atlas__list_items");
  expect(events[2].detail).toContain('"sessionId":"s1"');
  // A tool result names only the call it answers, so the name comes from the tool_use seen earlier.
  expect(events[3].tool).toBe("mcp__atlas__list_items");
  expect(events[3].detail).toContain("total");
  expect(outcome.text).toBe("12 items are still pending.");
  expect(outcome.events).toBe(6);
});

test("the session id is announced once", () => {
  const { events } = translate(
    '{"type":"system","session_id":"x"}\n{"type":"system","session_id":"x"}\n{"type":"system","session_id":"y"}',
  );
  expect(events.map((event) => event.session)).toEqual(["x", "y"]);
});

test("a failed run reports the error and no answer", () => {
  const { events, outcome } = translate('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"the tool crashed"}');
  expect(events).toEqual([{ kind: "error", content: "the tool crashed" }]);
  expect(outcome.text).toBe("");
});

test("a failed run without a message falls back to its subtype", () => {
  const { events } = translate('{"type":"result","subtype":"error_max_budget_usd","is_error":true}');
  expect(events[0].content).toBe("the assistant stopped: error_max_budget_usd");
});

test("a truncated stream keeps whatever arrived", () => {
  const { events, outcome } = translate(
    '{"type":"system","subtype":"init","session_id":"abc-123"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"partial',
  );
  expect(events).toEqual([{ kind: "session", session: "abc-123" }]);
  expect(outcome.text).toBe("");
});

test("resultText flattens both content shapes", () => {
  expect(resultText("plain")).toBe("plain");
  expect(resultText([{ type: "text", text: "one" }, { type: "text", text: "two" }])).toBe("one\ntwo");
  expect(resultText(undefined)).toBe("");
  expect(tail("")).toBe("");
  expect(tail("x".repeat(600))).toHaveLength(2 + 1 + 500);
});

test("the byte stream is reassembled across chunk boundaries", async () => {
  const bytes = new TextEncoder().encode(`${STREAM}\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) {
        controller.enqueue(bytes.slice(offset, offset + 7));
      }
      controller.close();
    },
  });
  const events: AssistantEvent[] = [];
  const outcome = await readClaudeStream(stream, (event) => events.push(event));
  expect(events.map((event) => event.kind)).toEqual(["session", "thinking", "tool", "tool_result", "message"]);
  expect(outcome.text).toBe("12 items are still pending.");
});

test("arguments carry the Atlas MCP server, session, model and budget", () => {
  const args = argumentsFor({ model: "opus", maxBudgetUsd: 2 }, { session: "abc-123", sessionId: "s1" });
  expect(args[0]).toBe("claude");
  for (const expected of ["--print", "--verbose", "--strict-mcp-config", "--setting-sources"]) {
    expect(args).toContain(expected);
  }
  expect(valueAfter(args, "--output-format")).toBe("stream-json");
  expect(valueAfter(args, "--resume")).toBe("abc-123");
  expect(valueAfter(args, "--model")).toBe("opus");
  expect(valueAfter(args, "--max-budget-usd")).toBe("2");
  expect(valueAfter(args, "--add-dir")).toBe("/tmp/workspace");
  expect(JSON.parse(valueAfter(args, "--mcp-config") as string)).toEqual({
    mcpServers: { atlas: { type: "http", url: launch.mcpUrl } },
  });
  expect(valueAfter(args, "--append-system-prompt")).toContain("session s1");
  expect(valueAfter(args, "--tools")).toBe(DEFAULT_TOOLS.join(","));
  expect(valueAfter(args, "--allowedTools")).toBe(DEFAULT_ALLOWED_TOOLS.join(","));
});

test("the machine user's own configuration is isolated", () => {
  const args = argumentsFor();
  expect(args).toContain("--setting-sources");
  expect(valueAfter(args, "--setting-sources")).toBe("");
});

test("a fresh conversation resumes nothing", () => {
  expect(argumentsFor().join(" ")).not.toContain("--resume");
  expect(argumentsFor({}, { session: "" }).join(" ")).not.toContain("--resume");
});

test("permissions are never skipped", () => {
  const args = argumentsFor({ model: "opus", maxBudgetUsd: 1 }, { session: "abc", sessionId: "s", projectId: "p" });
  for (const argument of args) {
    expect(argument).not.toContain("dangerously");
    expect(argument).not.toBe("--permission-mode");
  }
});

test("custom tools replace the defaults", () => {
  const args = argumentsFor({ tools: ["Read"], allowedTools: ["Read", "mcp__atlas__get_session"] });
  expect(valueAfter(args, "--tools")).toBe("Read");
  expect(valueAfter(args, "--allowedTools")).toBe("Read,mcp__atlas__get_session");
});

test("the system prompt stays generic and carries the context", () => {
  const prompt = claudeSystemPrompt({ messages: [], sessionId: "s1", projectId: "p1" }, "/ws");
  expect(prompt).toContain("general-purpose");
  expect(prompt).toContain("session s1");
  expect(prompt).toContain("project is p1");
  expect(prompt).toContain("/ws");
  expect(mcpConfigJson("http://x/api/mcp")).toContain('"type":"http"');
});

test("config defaults", () => {
  const resolved = resolveConfig({});
  expect(resolved.binary).toBe("claude");
  expect(resolved.timeoutSeconds).toBe(900);
  expect(resolved.model).toBeUndefined();
  expect(resolved.maxBudgetUsd).toBeUndefined();
});

// --- backend with an injected spawner --------------------------------------------------------

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>;
}

interface FakeRun {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}

interface Spawned {
  command: string[];
  options: SpawnOptions;
  killed: boolean;
}

function scriptedSpawn(runs: FakeRun[], spawned: Spawned[]): SpawnClaude {
  return (command, options) => {
    const run = runs.shift() as FakeRun;
    const record: Spawned = { command, options, killed: false };
    spawned.push(record);
    const process: ClaudeProcess = {
      stdout: streamOf(run.stdout),
      stderr: streamOf(run.stderr || ""),
      exited: Promise.resolve(run.exitCode || 0),
      kill() {
        record.killed = true;
      },
    };
    return process;
  };
}

let workspaceDirectory: string;

beforeEach(() => {
  workspaceDirectory = makeTempDirectory();
});

afterEach(() => {
  fs.rmSync(workspaceDirectory, { recursive: true, force: true });
});

function backendWith(spawn: SpawnClaude, config: ClaudeConfig = {}, tracker = new ProcessTracker()) {
  return createClaudeBackend(
    { config: resolveConfig(config), spawn, tracker },
    { workspaceDirectory, mcpUrl: () => "http://127.0.0.1:1/api/mcp" },
  );
}

async function chat(backend: ReturnType<typeof backendWith>, turn: Partial<AssistantTurn> = {}, signal = new AbortController().signal) {
  const events: AssistantEvent[] = [];
  const fullTurn: AssistantTurn = { messages: [{ role: "user", content: "how many are pending?" }], ...turn };
  await backend.chat(fullTurn, (event) => events.push(event), signal);
  return events;
}

test("a turn pipes the prompt to stdin, runs in <workspace>/agent and ends with the answer", async () => {
  const spawned: Spawned[] = [];
  const backend = backendWith(scriptedSpawn([{ stdout: STREAM }], spawned));
  const events = await chat(backend, { sessionId: "s1" });
  expect(events.map((event) => event.kind)).toEqual(["session", "thinking", "tool", "tool_result", "message", "done"]);
  expect(JSON.parse(events[events.length - 1].content as string)).toEqual([
    { role: "assistant", content: "12 items are still pending." },
  ]);
  expect(spawned[0].options.stdin).toBe("how many are pending?");
  expect(spawned[0].options.cwd).toBe(path.join(workspaceDirectory, "agent"));
  expect(fs.existsSync(path.join(workspaceDirectory, "agent"))).toBe(true);
  expect(spawned[0].options.env.ATLAS_WORKSPACE).toBe(workspaceDirectory);
});

test("a resume that fails before any event is retried fresh, once", async () => {
  const spawned: Spawned[] = [];
  const backend = backendWith(
    scriptedSpawn([{ stdout: "", stderr: "No conversation found", exitCode: 1 }, { stdout: STREAM }], spawned),
  );
  const events = await chat(backend, { session: "stale-id" });
  expect(spawned).toHaveLength(2);
  expect(spawned[0].command).toContain("--resume");
  expect(spawned[1].command).not.toContain("--resume");
  expect(events.some((event) => event.kind === "error")).toBe(false);
  expect(events[events.length - 1].kind).toBe("done");
});

test("a failure after events were shown is not retried and reports stderr", async () => {
  const spawned: Spawned[] = [];
  const partial = '{"type":"system","session_id":"abc"}';
  const backend = backendWith(scriptedSpawn([{ stdout: partial, stderr: "it broke", exitCode: 2 }], spawned));
  const events = await chat(backend, { session: "abc" });
  expect(spawned).toHaveLength(1);
  expect(events[events.length - 1]).toEqual({ kind: "error", content: "claude failed: exit code 2: it broke" });
});

test("a failure on a fresh conversation is not retried", async () => {
  const spawned: Spawned[] = [];
  const backend = backendWith(scriptedSpawn([{ stdout: "", exitCode: 1 }], spawned));
  const events = await chat(backend);
  expect(spawned).toHaveLength(1);
  expect(events[0].kind).toBe("error");
});

test("a turn without a user message is refused", async () => {
  const spawned: Spawned[] = [];
  const backend = backendWith(scriptedSpawn([], spawned));
  const events = await chat(backend, { messages: [{ role: "assistant", content: "hi" }] });
  expect(events[0].kind).toBe("error");
  expect(spawned).toHaveLength(0);
});

test("a binary that cannot start is reported", async () => {
  const backend = backendWith(() => {
    throw new Error("ENOENT");
  });
  const events = await chat(backend);
  expect(events).toEqual([{ kind: "error", content: "cannot run claude: ENOENT" }]);
});

// --- real processes ---------------------------------------------------------------------------

function writeFakeClaude(body: string): string {
  const scriptPath = path.join(workspaceDirectory, "fake-claude.sh");
  fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return scriptPath;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function hangingClaude(): { binary: string; pidFile: string } {
  const pidFile = path.join(workspaceDirectory, "pid");
  const binary = writeFakeClaude(
    `echo $$ > "${pidFile}"\necho '{"type":"system","subtype":"init","session_id":"abc"}'\nexec sleep 30`,
  );
  return { binary, pidFile };
}

async function pidOf(pidFile: string): Promise<number> {
  await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "");
  return Number(fs.readFileSync(pidFile, "utf8").trim());
}

test("a real process is spawned, fed the prompt and read", async () => {
  const binary = writeFakeClaude(
    `read prompt\necho '{"type":"result","subtype":"success","is_error":false,"result":"echo: '"$prompt"'"}'`,
  );
  const backend = backendWith(spawnWithBun, { binary });
  const events = await chat(backend);
  expect(JSON.parse(events[events.length - 1].content as string)[0].content).toBe("echo: how many are pending?");
});

test("aborting the request kills the process", async () => {
  const { binary, pidFile } = hangingClaude();
  const tracker = new ProcessTracker();
  const backend = backendWith(spawnWithBun, { binary }, tracker);
  const controller = new AbortController();
  const running = chat(backend, {}, controller.signal);
  const pid = await pidOf(pidFile);
  expect(tracker.size).toBe(1);
  controller.abort();
  const events = await running;
  expect(events.some((event) => event.kind === "error")).toBe(false);
  await waitFor(() => !isAlive(pid));
  expect(tracker.size).toBe(0);
});

test("a turn that outlives the timeout is killed and reported", async () => {
  const { binary, pidFile } = hangingClaude();
  const backend = backendWith(spawnWithBun, { binary, timeoutSeconds: 0.3 });
  const events = await chat(backend);
  expect(events[events.length - 1].content).toContain("did not finish");
  await waitFor(() => !isAlive(Number(fs.readFileSync(pidFile, "utf8").trim())));
});

// --- plugin lifecycle -------------------------------------------------------------------------

test("the plugin registers a backend, points it at this host's MCP endpoint and kills processes on dispose", async () => {
  const host: Host = await startHost(workspaceDirectory);
  try {
    await host.context.plugin(Assistant as never, {} as never);
    const spawned: Spawned[] = [];
    const plugin = createClaudePlugin({ spawn: scriptedSpawn([{ stdout: STREAM }], spawned) });
    const fiber = host.context.plugin(plugin as never, {} as never);
    await fiber;
    const backend = host.context.assistantBackends.get("claude");
    expect(backend).toBeDefined();
    await backend!.chat({ messages: [{ role: "user", content: "hi" }] }, () => {}, new AbortController().signal);
    const mcpConfig = JSON.parse(valueAfter(spawned[0].command, "--mcp-config") as string);
    expect(mcpConfig.mcpServers.atlas.url).toBe(`http://127.0.0.1:${host.context.http.port}/api/mcp`);

    await fiber.dispose();
    expect(host.context.assistantBackends.list()).toEqual([]);
  } finally {
    await host.stop();
  }
});

test("disposing the plugin kills a running process", async () => {
  const host: Host = await startHost(workspaceDirectory);
  try {
    await host.context.plugin(Assistant as never, {} as never);
    const { binary, pidFile } = hangingClaude();
    const fiber = host.context.plugin(createClaudePlugin() as never, { binary } as never);
    await fiber;
    const backend = host.context.assistantBackends.get("claude")!;
    const events: AssistantEvent[] = [];
    const running = backend.chat(
      { messages: [{ role: "user", content: "hi" }] },
      (event) => events.push(event),
      new AbortController().signal,
    );
    const pid = await pidOf(pidFile);
    await fiber.dispose();
    await running;
    await waitFor(() => !isAlive(pid));
    expect(events.some((event) => event.kind === "error")).toBe(false);
  } finally {
    await host.stop();
  }
});
