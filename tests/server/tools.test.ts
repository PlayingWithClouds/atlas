import { expect, test } from "bun:test";
import { Context } from "@neoworks/extension-system";
import ToolsCore from "../../packages/server/src/services/tools";
import type { Tool } from "../../packages/contracts/src/server";

function makeTool(name: string, overrides: Partial<Tool> = {}): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, required: [] },
    readOnly: true,
    async run() {
      return [{ type: "text", text: "ok" }];
    },
    ...overrides,
  };
}

async function mountTools() {
  const context = new Context();
  await context.plugin(ToolsCore as never);
  return context;
}

test("register returns a disposer, rejects duplicates and lists sorted by name", async () => {
  const { tools } = await mountTools();
  const disposeB = tools.register(makeTool("b"));
  tools.register(makeTool("a"));
  expect(() => tools.register(makeTool("a"))).toThrow();
  expect(tools.list().map((tool) => tool.name)).toEqual(["a", "b"]);
  disposeB();
  expect(tools.list().map((tool) => tool.name)).toEqual(["a"]);
});

test("call returns content on success", async () => {
  const { tools } = await mountTools();
  tools.register(makeTool("echo", { async run(args) { return [{ type: "text", text: String(args.word) }]; } }));
  const outcome = await tools.call("echo", { word: "hi" }, {});
  expect(outcome).toEqual({ content: [{ type: "text", text: "hi" }], isError: false });
});

test("unknown tools are reported in-band, not thrown", async () => {
  const { tools } = await mountTools();
  const outcome = await tools.call("teleport", {}, {});
  expect(outcome.isError).toBe(true);
  expect(outcome.content[0].text).toContain("unknown tool");
});

test("missing required arguments are reported in-band and the tool never runs", async () => {
  const { tools } = await mountTools();
  let ran = false;
  tools.register(makeTool("needs", {
    inputSchema: { type: "object", properties: {}, required: ["sid", "graph"] },
    async run() { ran = true; return []; },
  }));
  const outcome = await tools.call("needs", { sid: "s" }, {});
  expect(outcome.isError).toBe(true);
  expect(outcome.content[0].text).toContain("graph");
  expect(ran).toBe(false);
});

test("a throwing tool becomes an in-band error", async () => {
  const { tools } = await mountTools();
  tools.register(makeTool("boom", { async run() { throw new Error("nope"); } }));
  const outcome = await tools.call("boom", {}, {});
  expect(outcome).toEqual({ content: [{ type: "text", text: "nope" }], isError: true });
});

test("tools registered inside a plugin effect vanish when it is disposed", async () => {
  const context = await mountTools();
  const fiber = context.plugin({
    name: "tool-plugin",
    inject: ["tools"],
    apply(ctx: Context) {
      ctx.effect(() => ctx.tools.register(makeTool("temp")), "tool:temp");
    },
  } as never);
  await fiber;
  expect(context.tools.list().length).toBe(1);
  await fiber.dispose();
  expect(context.tools.list().length).toBe(0);
});
