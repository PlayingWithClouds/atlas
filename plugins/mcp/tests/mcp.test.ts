import fs from "node:fs";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Fiber } from "@neoworks/extension-system";
import type { Tool } from "@atlas/contracts/server";
import { assistantTools } from "../../core-nodes/src/tools";
import { makeTempDirectory, startHost, urlOf } from "../../../tests/server/helpers";
import type { Host } from "../../../packages/server/src/index";
import { coerceArguments, integerArgument, objectListArgument, stringArgument, stringListArgument, graphArgument } from "../src/arguments";
import { PROTOCOL_VERSION } from "../src/protocol";
import Mcp from "../src/server";

let host: Host;
let workspaceDirectory: string;
let fiber: Fiber;

beforeEach(async () => {
  workspaceDirectory = makeTempDirectory();
  host = await startHost(workspaceDirectory);
});

afterEach(async () => {
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
      return [{ type: "text", text: "ok" }];
    },
    ...overrides,
  };
}

async function mount(config: Record<string, unknown> = {}): Promise<void> {
  fiber = host.context.plugin(Mcp as never, config as never);
  await fiber;
}

async function post(body: string, pathname = "/api/mcp"): Promise<Response> {
  return fetch(urlOf(host, pathname), { method: "POST", body });
}

async function rpc(body: unknown): Promise<Record<string, any>> {
  const response = await post(JSON.stringify(body));
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

function textOf(result: Record<string, any>): string {
  return result.content[0].text;
}

function registerRealTools(): void {
  const { items, projects, models, primitives, workflows, tools } = host.context;
  for (const tool of assistantTools({ items, projects, models, primitives, workflows })) {
    tools.register(tool);
  }
}

test("initialize reports the tool capability and instructions", async () => {
  await mount();
  const { result } = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(result.capabilities.tools).toBeDefined();
  expect(result.instructions).toContain("data labeling");
});

test("notifications get 202 and no body", async () => {
  await mount();
  const response = await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  expect(response.status).toBe(202);
  expect(await response.text()).toBe("");
});

test("the trailing-slash path answers too", async () => {
  await mount();
  const response = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), "/api/mcp/");
  expect(((await response.json()) as any).result).toEqual({});
});

test("tools/list is sorted and describes every schema", async () => {
  await mount();
  host.context.tools.register(fakeTool("zeta"));
  host.context.tools.register(fakeTool("alpha"));
  const { result } = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect(result.tools.map((tool: any) => tool.name)).toEqual(["alpha", "zeta"]);
  for (const tool of result.tools) {
    expect(tool.description).not.toBe("");
    expect(tool.inputSchema.type).toBe("object");
  }
});

test("the default surface is read-and-propose only", async () => {
  await mount();
  registerRealTools();
  host.context.tools.register(fakeTool("contact_sheet"));
  host.context.tools.register(fakeTool("delete_everything", { readOnly: false }));
  host.context.tools.register(fakeTool("confirm_labels", { readOnly: false }));
  const allowed = new Set([
    "contact_sheet",
    "dry_run_workflow",
    "get_insights",
    "get_session",
    "list_classes",
    "list_items",
    "list_node_types",
    "list_sessions",
    "list_workflows",
    "preview_predictions",
    "propose_labels", // writes proposals only; a human confirms them
    "save_workflow", // saves a manual draft; never auto-triggered
    "validate_workflow",
  ]);
  const { result } = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const listed = new Set<string>(result.tools.map((tool: any) => tool.name));
  for (const name of listed) {
    expect(allowed.has(name)).toBe(true);
  }
  for (const name of allowed) {
    expect(listed.has(name)).toBe(true);
  }
});

test("allowWrites exposes write tools", async () => {
  await mount({ allowWrites: true });
  host.context.tools.register(fakeTool("delete_everything", { readOnly: false }));
  const { result } = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  expect(result.tools.map((tool: any) => tool.name)).toEqual(["delete_everything"]);
});

test("a hidden write tool cannot be called", async () => {
  await mount();
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
  const { result } = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "delete_everything", arguments: {} } });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("unknown tool");
  expect(ran).toBe(false);
});

test("unknown tools are reported in-band", async () => {
  await mount();
  const { result } = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "teleport", arguments: {} } });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("unknown tool");
});

test("missing arguments are reported in-band", async () => {
  await mount();
  registerRealTools();
  const { result } = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_session", arguments: {} } });
  expect(result.isError).toBe(true);
});

test("loosely typed arguments are coerced before the tool runs", async () => {
  await mount();
  let received: Record<string, unknown> = {};
  host.context.tools.register(
    fakeTool("count", {
      inputSchema: { type: "object", properties: { n: { type: "integer" }, name: { type: "string" } }, required: ["n"] },
      async run(args) {
        received = args;
        return [{ type: "text", text: "done" }];
      },
    }),
  );
  const { result } = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "count", arguments: { n: "12", name: 7 } } });
  expect(result.isError).toBe(false);
  expect(received).toEqual({ n: 12, name: "7" });
});

test("image content is passed through", async () => {
  await mount();
  host.context.tools.register(
    fakeTool("picture", {
      async run() {
        return [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }];
      },
    }),
  );
  const { result } = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "picture" } });
  expect(result.content[0]).toEqual({ type: "image", data: "AAAA", mimeType: "image/jpeg" });
});

test("unsupported methods are JSON-RPC errors", async () => {
  await mount();
  const response = await rpc({ jsonrpc: "2.0", id: 5, method: "resources/list" });
  expect(response.error.code).toBe(-32601);
});

test("malformed and non-2.0 requests are rejected", async () => {
  await mount();
  const malformed = (await (await post("{oh no")).json()) as any;
  expect(malformed.error.message).toContain("malformed");
  const wrongVersion = await rpc({ jsonrpc: "1.0", id: 6, method: "tools/list" });
  expect(wrongVersion.error).toBeDefined();
});

test("GET is refused with 405", async () => {
  await mount();
  const response = await fetch(urlOf(host, "/api/mcp"));
  expect(response.status).toBe(405);
});

test("validate_workflow reports a bad node as a result, not a tool failure", async () => {
  await mount();
  registerRealTools();
  const graph = { nodes: [{ id: "a", type: "teleport", position: { x: 0, y: 0 } }], edges: [] };
  const { result } = await rpc({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "validate_workflow", arguments: { graph: JSON.stringify(graph) } },
  });
  expect(result.isError).toBe(false);
  expect(textOf(result)).toContain("teleport");
});

test("disposing the plugin removes the routes", async () => {
  await mount();
  await fiber.dispose();
  const response = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  expect(response.status).toBe(404);
});

test("argument readers coerce loose types", () => {
  const args = { count: 12.7, name: 7, labels: ["a", 2], items: [{ a: 1 }, "x"], text: "42" };
  expect(integerArgument(args, "count", 0)).toBe(12);
  expect(integerArgument(args, "text", 0)).toBe(42);
  expect(integerArgument(args, "missing", 5)).toBe(5);
  expect(stringArgument(args, "name")).toBe("7");
  expect(stringArgument(args, "missing")).toBe("");
  expect(stringListArgument(args, "labels")).toEqual(["a", "2"]);
  expect(objectListArgument(args, "items")).toEqual([{ a: 1 }]);
  expect(() => graphArgument(args, "graph")).toThrow("required");
});

test("coerceArguments handles stringified structures and non-object input", () => {
  const schema = { properties: { graph: { type: "object" }, tags: { type: "array" }, flag: { type: "boolean" } } };
  const coerced = coerceArguments({ graph: '{"nodes":[]}', tags: '["a"]', flag: "true", extra: 1 }, schema);
  expect(coerced).toEqual({ graph: { nodes: [] }, tags: ["a"], flag: true, extra: 1 });
  expect(coerceArguments(null, schema)).toEqual({});
  expect(coerceArguments('{"flag":"false"}', schema)).toEqual({ flag: false });
});
