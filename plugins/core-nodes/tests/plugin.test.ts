import { expect, test } from "bun:test";
import type { Fiber } from "@neoworks/extension-system";
import type { Workflow, WorkItem } from "@atlas/contracts";
import ToolsCore from "../../../packages/server/src/services/tools";
import WorkflowsCore from "../../../packages/server/src/services/workflows";
import { createStubWorld } from "../../../tests/server/stubs";
import type { StubWorld } from "../../../tests/server/stubs";
import coreNodes from "../src/server";

const EXPECTED_NODES = ["action", "filter", "notify", "sample", "save", "session-items"];
const EXPECTED_TRIGGERS = ["item_accepted", "item_opened", "item_rejected", "manual", "session_closed", "session_created", "session_opened"];
const EXPECTED_TOOLS = [
  "dry_run_workflow", "get_insights", "get_session", "list_classes", "list_items", "list_node_types",
  "list_sessions", "list_workflows", "preview_predictions", "propose_labels", "save_workflow", "validate_workflow",
];

async function mountAll(): Promise<{ world: StubWorld; fiber: Fiber }> {
  const world = createStubWorld();
  await world.context.plugin(WorkflowsCore as never, undefined as never);
  await world.context.plugin(ToolsCore as never, undefined as never);
  const fiber = world.context.plugin(coreNodes as never, undefined as never) as Fiber;
  await fiber;
  return { world, fiber };
}

function graphJson(nodes: [string, string, Record<string, unknown>?][], edges: [string, string][]) {
  return {
    nodes: nodes.map(([id, type, params]) => ({ id, type, params, position: { x: 0, y: 0 } })),
    edges: edges.map(([source, target]) => ({ source, target })),
  };
}

test("registers the standard nodes, triggers and the read-and-propose tool surface", async () => {
  const { world } = await mountAll();
  const { workflows, tools } = world.context;
  expect(workflows.nodes().map((spec) => spec.type).sort()).toEqual(EXPECTED_NODES);
  expect(workflows.triggers().map((trigger) => trigger.id).sort()).toEqual(EXPECTED_TRIGGERS);
  expect(tools.list().map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
  const writers = tools.list().filter((tool) => !tool.readOnly).map((tool) => tool.name);
  expect(writers).toEqual(["propose_labels", "save_workflow"]);
  for (const tool of tools.list()) {
    expect((tool.inputSchema as { type: string }).type).toBe("object");
    expect(Array.isArray((tool.inputSchema as { required: unknown }).required)).toBe(true);
  }
});

test("disposing the plugin leaves no nodes, triggers, tools or event listeners", async () => {
  const { world, fiber } = await mountAll();
  const project = world.addProject();
  const session = world.addSession(project.id);
  await fiber.dispose();
  const { workflows, tools } = world.context;
  expect(workflows.nodes()).toEqual([]);
  expect(workflows.triggers()).toEqual([]);
  expect(tools.list()).toEqual([]);

  const workflow: Workflow = { id: "w", label: "W", triggers: ["session_created"], graph: graphJson([["a", "x"]], []) };
  workflows.save(workflow);
  const emit = (world.context as any).emit.bind(world.context);
  emit("session/created", session);
  emit("session/opened", session);
  emit("session/closed", session);
  expect(world.jobs.submitted).toEqual([]);
});

test("session_created fires a workflow that filters, samples and accepts", async () => {
  const { world } = await mountAll();
  const project = world.addProject();
  const session = world.addSession(project.id);
  const items = world.addItems(session.id, ["a", "b", "c", "d"]);
  world.items.set(items[0].id, { ...items[0], annotations: [{ type: "tag", value: { labels: ["x"] } }] });
  world.items.set(items[1].id, { ...items[1], annotations: [{ type: "tag", value: { labels: ["x"] } }] });
  world.context.workflows.save({
    id: "auto",
    label: "Auto accept",
    projectId: project.id,
    triggers: ["session_created"],
    graph: graphJson(
      [["s", "session-items"], ["f", "filter", { field: "label", op: "is", value: "x" }], ["m", "sample", { order: "natural", count: 1 }], ["a", "action", { action: "accept" }]],
      [["s", "f"], ["f", "m"], ["m", "a"]],
    ),
  });

  (world.context as any).emit("session/created", session);
  await world.jobs.settle();

  expect(world.jobs.submitted[0].state).toBe("done");
  expect(world.calls.confirm).toEqual([items[0].id]);
});

test("item_accepted scopes the run to the labeled item", async () => {
  const { world } = await mountAll();
  const project = world.addProject();
  const session = world.addSession(project.id);
  const [first, second] = world.addItems(session.id, ["a", "b"]);
  world.context.workflows.save({
    id: "on-accept",
    label: "On accept",
    triggers: ["item_accepted"],
    graph: graphJson([["s", "session-items"], ["a", "action", { action: "skip" }]], [["s", "a"]]),
  });
  (world.context as any).emit("items/labeled", { ...second, status: "labeled" });
  await world.jobs.settle();
  expect(world.calls.skip).toEqual([second.id]);
  expect(world.calls.skip).not.toContain(first.id);
});

test("item/opened and item/rejected events fire their triggers", async () => {
  const { world } = await mountAll();
  const project = world.addProject();
  const session = world.addSession(project.id);
  const [item] = world.addItems(session.id, ["a"]);
  const noopGraph = graphJson([["s", "session-items"]], []);
  world.context.workflows.save({ id: "opened", label: "o", triggers: ["item_opened"], graph: noopGraph });
  world.context.workflows.save({ id: "rejected", label: "r", triggers: ["item_rejected"], graph: noopGraph });
  (world.context as any).emit("item/opened", item);
  (world.context as any).emit("item/rejected", item);
  await world.jobs.settle();
  expect(world.jobs.submitted.map((job) => job.extra.workflow).sort()).toEqual(["opened", "rejected"]);
});

test("save node proposes annotations and marks embedded", async () => {
  const { world } = await mountAll();
  const project = world.addProject();
  const session = world.addSession(project.id);
  const [item] = world.addItems(session.id, ["a"]);
  const { workflows } = world.context;
  workflows.registerNode({
    type: "fake-embed", plugin: "t", label: "E", description: "", input: "items", output: "items", params: [],
    async run(items) {
      const sparse = items.map((entry) => ({ ref: entry.ref, embedded: true, annotations: [{ type: "tag", value: { labels: ["x"] } }] }));
      return { items: sparse as unknown as WorkItem[] };
    },
  });
  workflows.save({ id: "w", label: "W", triggers: ["manual"], graph: graphJson([["s", "session-items"], ["e", "fake-embed"], ["v", "save", { mode: "propose" }]], [["s", "e"], ["e", "v"]]) });
  workflows.run("w", session.id);
  await world.jobs.settle();
  const stored = world.items.get(item.id);
  expect(stored?.embedded).toBe(true);
  expect(stored?.annotations).toEqual([{ type: "tag", value: { labels: ["x"] } }]);
  expect(world.calls.backfill).toEqual([session.id]);
});

test("notify node toasts a rendered template at the end of a workflow", async () => {
  const { world } = await mountAll();
  const project = world.addProject();
  const session = world.addSession(project.id);
  world.addItems(session.id, ["a", "b"]);
  const { workflows } = world.context;
  workflows.save({ id: "w", label: "W", triggers: ["manual"], graph: graphJson([["s", "session-items"], ["n", "notify", { message: "saw {{count}} in {{session.label}}" }]], [["s", "n"]]) });
  workflows.run("w", session.id);
  await world.jobs.settle();
  expect(world.toasts.map((toast) => toast.message)).toContain("saw 2 in Session");
});

// --- tools -------------------------------------------------------------------------------

test("read tools describe sessions, items and classes", async () => {
  const { world } = await mountAll();
  const { tools } = world.context;
  const project = world.addProject();
  const session = world.addSession(project.id);
  world.addItems(session.id, ["a", "b", "c"]);

  const sessions = await tools.call("list_sessions", { project: project.id }, {});
  expect(JSON.parse(sessions.content[0].text as string).sessions).toHaveLength(1);

  const listed = await tools.call("list_items", { sid: session.id, limit: 2 }, {});
  expect(JSON.parse(listed.content[0].text as string)).toMatchObject({ total: 3, returned: 2 });

  const classes = await tools.call("list_classes", { project: project.id }, {});
  expect(JSON.parse(classes.content[0].text as string).classes).toEqual(["a", "b"]);

  const missing = await tools.call("get_session", { sid: "ghost" }, {});
  expect(missing.isError).toBe(true);
  expect((await tools.call("get_session", {}, {})).isError).toBe(true);
});

test("preview_predictions reads pending embedded items without writing", async () => {
  const { world } = await mountAll();
  const project = world.addProject();
  const session = world.addSession(project.id);
  world.addItems(session.id, ["a"], { embedded: true });
  world.addItems(session.id, ["b"]);
  const outcome = await world.context.tools.call("preview_predictions", { sid: session.id }, {});
  expect(Object.keys(JSON.parse(outcome.content[0].text as string).predictions)).toEqual(["a"]);
});

test("propose_labels writes normalized proposals only for items in the session", async () => {
  const { world } = await mountAll();
  const project = world.addProject();
  const session = world.addSession(project.id);
  const other = world.addSession(project.id);
  const [mine] = world.addItems(session.id, ["a"]);
  const [foreign] = world.addItems(other.id, ["z"]);
  const outcome = await world.context.tools.call("propose_labels", {
    sid: session.id,
    proposals: [
      { itemId: mine.id, annotations: [{ type: "tag", value: { labels: ["a"] } }, { type: "unknown", value: {} }] },
      { itemId: foreign.id, annotations: [{ type: "tag", value: { labels: ["a"] } }] },
    ],
  }, {});
  expect(JSON.parse(outcome.content[0].text as string).proposed).toBe(1);
  expect(world.items.get(mine.id)?.annotations).toEqual([{ type: "tag", value: { labels: ["a"] } }]);
  expect(world.items.get(foreign.id)?.annotations).toEqual([]);
  expect(world.calls.confirm).toEqual([]);
});

test("workflow tools validate, dry-run and save drafts with manual triggers only", async () => {
  const { world } = await mountAll();
  const { tools, workflows } = world.context;
  const project = world.addProject();
  const session = world.addSession(project.id);
  world.addItems(session.id, ["a", "b"]);
  const graph = graphJson([["s", "session-items"], ["m", "sample", { count: 1 }]], [["s", "m"]]);

  const nodeTypes = await tools.call("list_node_types", { project: project.id }, {});
  expect(JSON.parse(nodeTypes.content[0].text as string).nodes).toHaveLength(6);

  const bad = await tools.call("validate_workflow", { graph: graphJson([["x", "teleport"]], []) }, {});
  expect(JSON.parse(bad.content[0].text as string).ok).toBe(false);

  const dry = await tools.call("dry_run_workflow", { sid: session.id, graph }, {});
  const dryReport = JSON.parse(dry.content[0].text as string);
  expect(dryReport.entities).toBe(2);
  expect(dryReport.nodes[1].out).toBe(1);

  const rejected = await tools.call("save_workflow", { id: "w", label: "W", graph: graphJson([["x", "teleport"]], []) }, {});
  expect(JSON.parse(rejected.content[0].text as string).saved).toBe(false);
  expect(workflows.list()).toEqual([]);

  const saved = await tools.call("save_workflow", { id: "w", label: "W", project: project.id, graph }, {});
  expect(JSON.parse(saved.content[0].text as string).saved).toBe(true);
  expect(workflows.list()[0]).toMatchObject({ id: "w", triggers: ["manual"], projectId: project.id });

  const listed = await tools.call("list_workflows", {}, {});
  expect(JSON.parse(listed.content[0].text as string).workflows).toHaveLength(1);
  expect((await tools.call("validate_workflow", { graph: "nope" }, {})).isError).toBe(true);
});
