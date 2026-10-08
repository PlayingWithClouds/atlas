import { expect, test } from "bun:test";
import type { Workflow, WorkItem } from "../../packages/contracts/src/index";
import { HttpError } from "../../packages/contracts/src/server";
import type { NodeType } from "../../packages/contracts/src/server";
import { graphOf, makeNode, mountWorkflows, refsOf, sourceNode } from "./workflowFixtures";

async function setup(...extraNodes: NodeType[]) {
  const world = await mountWorkflows();
  const { workflows } = world.context;
  workflows.registerNode(sourceNode);
  for (const nodeType of extraNodes) {
    workflows.registerNode(nodeType);
  }
  const project = world.addProject();
  const session = world.addSession(project.id);
  return { world, workflows, project, session };
}

function workflowOf(id: string, graph: Workflow["graph"], extra: Partial<Workflow> = {}): Workflow {
  return { id, label: id, triggers: ["manual"], graph, ...extra };
}

// --- registries and persistence ----------------------------------------------------------

test("core ships no nodes or triggers; registration returns a disposer and rejects duplicates", async () => {
  const world = await mountWorkflows();
  const { workflows } = world.context;
  expect(workflows.nodes()).toEqual([]);
  expect(workflows.triggers()).toEqual([]);

  const dispose = workflows.registerNode(makeNode("a"));
  expect(() => workflows.registerNode(makeNode("a"))).toThrow();
  expect(workflows.nodes().map((spec) => spec.type)).toEqual(["a"]);
  expect("run" in workflows.nodes()[0]).toBe(false);
  dispose();
  expect(workflows.nodes()).toEqual([]);

  const disposeTrigger = workflows.registerTrigger({ id: "t", plugin: "test", label: "T", scope: "session" });
  expect(() => workflows.registerTrigger({ id: "t", plugin: "test", label: "T", scope: "session" })).toThrow();
  disposeTrigger();
  expect(workflows.triggers()).toEqual([]);
});

test("nodes(projectId) hides nodes whose mediaKinds exclude the project", async () => {
  const { workflows, project } = await setup(
    makeNode("images-only", { mediaKinds: ["image"] }),
    makeNode("video-only", { mediaKinds: ["video"] }),
    makeNode("any"),
  );
  const types = workflows.nodes(project.id).map((spec) => spec.type);
  expect(types.sort()).toEqual(["any", "images-only", "source"]);
  expect(workflows.nodes().length).toBe(4);
});

test("workflows persist through saveConfig and list() honours project scope", async () => {
  const { world, workflows } = await setup();
  const graph = graphOf([["s", "source"]], []);
  workflows.save(workflowOf("global", graph));
  workflows.save(workflowOf("mine", graph, { projectId: "p1" }));
  workflows.save(workflowOf("theirs", graph, { projectId: "p2" }));
  expect(world.savedConfigs.length).toBe(3);

  expect(workflows.list().map((workflow) => workflow.id)).toEqual(["global", "mine", "theirs"]);
  expect(workflows.list("p1").map((workflow) => workflow.id)).toEqual(["global", "mine"]);

  workflows.save(workflowOf("mine", graph, { projectId: "p1", label: "renamed" }));
  expect(workflows.list("p1")[1].label).toBe("renamed");
  expect(workflows.list().length).toBe(3);

  workflows.remove("global");
  expect(workflows.list().map((workflow) => workflow.id)).toEqual(["mine", "theirs"]);
});

test("routes save, list and delete workflows", async () => {
  const { world } = await setup();
  const graph = graphOf([["s", "source"]], []);
  const saved = (await world.callRoute("POST", "/api/workflows", { body: { id: "w", label: "W", graph } })) as Workflow;
  expect(saved.triggers).toEqual(["manual"]);
  expect(await world.callRoute("GET", "/api/workflows")).toHaveLength(1);
  await world.callRoute("DELETE", "/api/workflows/:id", { params: { id: "w" } });
  expect(await world.callRoute("GET", "/api/workflows")).toHaveLength(0);
  await expect(world.callRoute("POST", "/api/workflows", { body: { label: "x", graph: {} } })).rejects.toBeInstanceOf(HttpError);
});

// --- validation --------------------------------------------------------------------------

test("validate rejects unknown types, cycles and bad wiring", async () => {
  const { workflows } = await setup(makeNode("a"), makeNode("sink", { output: "none" }));
  const unknown = workflows.validate(graphOf([["x", "teleport"]], []));
  expect(unknown.ok).toBe(false);
  expect(unknown.errors[0]).toContain("unknown node type");

  const cycle = workflows.validate(graphOf([["a", "a"], ["b", "a"]], [["a", "b"], ["b", "a"]]));
  expect(cycle.errors).toContain("workflow graph has a cycle");

  const intoSource = workflows.validate(graphOf([["a", "a"], ["s", "source"]], [["a", "s"]]));
  expect(intoSource.errors[0]).toContain("takes no input");

  const fromSink = workflows.validate(graphOf([["k", "sink"], ["a", "a"]], [["k", "a"]]));
  expect(fromSink.errors[0]).toContain("no output");

  const dangling = workflows.validate(graphOf([["a", "a"]], [["a", "ghost"]]));
  expect(dangling.errors[0]).toContain("missing node");

  expect(workflows.validate(graphOf([], [])).errors).toEqual(["empty workflow graph"]);
});

test("validate checks params: unknown key, number range, option membership", async () => {
  const configurable = makeNode("configurable", {
    params: [
      { key: "count", kind: "number", label: "Count", min: 0, max: 10 },
      { key: "order", kind: "option", label: "Order", options: [{ value: "natural", label: "n" }, { value: "random", label: "r" }] },
    ],
  });
  const { workflows } = await setup(configurable);
  const check = (params: Record<string, unknown>) =>
    workflows.validate({ nodes: [{ id: "c", type: "configurable", params, position: { x: 0, y: 0 } }], edges: [] });

  expect(check({ count: 5, order: "random" }).ok).toBe(true);
  expect(check({ nope: 1 }).errors[0]).toContain('no param "nope"');
  expect(check({ count: -1 }).errors[0]).toContain("below the minimum");
  expect(check({ count: 11 }).errors[0]).toContain("above the maximum");
  expect(check({ count: "abc" }).errors[0]).toContain("wants a number");
  expect(check({ order: "sideways" }).errors[0]).toContain("not one of");
});

test("validate warns about mediaKind mismatch and unwired nodes, but stays ok", async () => {
  const { workflows, project } = await setup(makeNode("video-only", { mediaKinds: ["video"] }), makeNode("a"));
  const report = workflows.validate(graphOf([["s", "source"], ["v", "video-only"], ["a", "a"]], [["s", "v"]]), project.id);
  expect(report.ok).toBe(true);
  expect(report.warnings).toContain("node v (video-only) does not apply to image projects");
  expect(report.warnings).toContain("node a (a) is not connected to anything");

  const single = workflows.validate(graphOf([["a", "a"]], []));
  expect(single.warnings).toEqual([]);
});

// --- execution ---------------------------------------------------------------------------

test("executor runs in topological order and dedupes merged inputs by ref (first wins)", async () => {
  const order: string[] = [];
  const received: Record<string, WorkItem[]> = {};
  const tag = (label: string) =>
    makeNode(label, {
      async run(items, context) {
        order.push(label);
        received[label] = items;
        return { items: items.map((item) => ({ ...item, via: label })) };
      },
    });
  const { world, workflows, session } = await setup(tag("left"), tag("right"), tag("join"));
  world.addItems(session.id, ["a", "b"]);
  workflows.save(
    workflowOf(
      "diamond",
      graphOf([["j", "join"], ["l", "left"], ["r", "right"], ["s", "source"]], [["s", "l"], ["s", "r"], ["l", "j"], ["r", "j"]]),
    ),
  );
  workflows.run("diamond", session.id);
  await world.jobs.settle();

  expect(order).toEqual(["left", "right", "join"]);
  expect(refsOf(received.join)).toEqual(["a", "b"]);
  expect(received.join[0].via).toBe("left");
  expect(world.jobs.submitted[0].state).toBe("done");
  expect(world.toasts.at(-1)?.level).toBe("success");
});

test("accepts splits the stream; non-matching items pass around the node", async () => {
  const seen: string[][] = [];
  const embedNode = makeNode("embed", {
    accepts: { embedded: false },
    async run(items) {
      seen.push(refsOf(items));
      return { items: items.map((item) => ({ ref: item.ref, embedded: true })) };
    },
  });
  const collector: WorkItem[][] = [];
  const collect = makeNode("collect", {
    async run(items) {
      collector.push(items);
      return { items };
    },
  });
  const { world, workflows, session } = await setup(embedNode, collect);
  world.addItems(session.id, ["a", "b"]);
  world.addItems(session.id, ["c"], { embedded: true, status: "labeled" });
  workflows.save(workflowOf("w", graphOf([["s", "source"], ["e", "embed"], ["c", "collect"]], [["s", "e"], ["e", "c"]])));
  workflows.run("w", session.id);
  await world.jobs.settle();

  expect(seen).toEqual([["a", "b"]]);
  const downstream = collector[0];
  expect(refsOf(downstream).sort()).toEqual(["a", "b", "c"]);
  const overlayed = downstream.find((item) => item.ref === "a") as WorkItem;
  expect(overlayed.embedded).toBe(true);
  expect(overlayed.status).toBe("pending");
});

test("accepts supports the annotation key", async () => {
  const seen: string[][] = [];
  const { world, workflows, session } = await setup(
    makeNode("needs-tag", {
      accepts: { annotation: "tag" },
      async run(items) {
        seen.push(refsOf(items));
        return { items };
      },
    }),
  );
  world.addItems(session.id, ["a"], { annotations: [{ type: "tag", value: { labels: ["x"] } }] });
  world.addItems(session.id, ["b"]);
  workflows.save(workflowOf("w", graphOf([["s", "source"], ["n", "needs-tag"]], [["s", "n"]])));
  workflows.run("w", session.id);
  await world.jobs.settle();
  expect(seen).toEqual([["a"]]);
});

test("a node that matches nothing toasts why and lets items flow on", async () => {
  const ran: string[] = [];
  const { world, workflows, session } = await setup(
    makeNode("embed", { label: "Embed", accepts: { embedded: false }, async run(items) { ran.push("embed"); return { items }; } }),
    makeNode("tail", { async run(items) { ran.push(`tail:${items.length}`); return { items }; } }),
  );
  world.addItems(session.id, ["a"], { embedded: true });
  workflows.save(workflowOf("w", graphOf([["s", "source"], ["e", "embed"], ["t", "tail"]], [["s", "e"], ["e", "t"]])));
  workflows.run("w", session.id);
  await world.jobs.settle();
  expect(ran).toEqual(["tail:1"]);
  expect(world.toasts.some((toast) => toast.message === "Embed skipped - none of the 1 items are unembedded")).toBe(true);
});

test("batch calls run once per chunk and message is toasted once", async () => {
  const sizes: number[] = [];
  const { world, workflows, session } = await setup(
    makeNode("chunky", {
      batch: 2,
      async run(items) {
        sizes.push(items.length);
        return { items, message: "heads up" };
      },
    }),
  );
  world.addItems(session.id, ["a", "b", "c", "d", "e"]);
  workflows.save(workflowOf("w", graphOf([["s", "source"], ["c", "chunky"]], [["s", "c"]])));
  workflows.run("w", session.id);
  await world.jobs.settle();
  expect(sizes).toEqual([2, 2, 1]);
  expect(world.toasts.filter((toast) => toast.message === "heads up").length).toBe(1);
});

test("the reserved action field is applied through labeling/items and consumed", async () => {
  const downstream: string[][] = [];
  const decide = makeNode("decide", {
    async run(items) {
      const actions: Record<string, string> = { a: "accept", b: "reject", c: "delete", d: "skip" };
      return { items: items.map((item) => (actions[item.ref] ? { ...item, action: actions[item.ref] } : item)) };
    },
  });
  const tail = makeNode("tail", { async run(items) { downstream.push(refsOf(items)); return { items }; } });
  const { world, workflows, session } = await setup(decide, tail);
  const [a, b, c, d] = world.addItems(session.id, ["a", "b", "c", "d", "e"]);
  workflows.save(workflowOf("w", graphOf([["s", "source"], ["d", "decide"], ["t", "tail"]], [["s", "d"], ["d", "t"]])));
  workflows.run("w", session.id);
  await world.jobs.settle();

  expect(world.calls.confirm).toEqual([a.id]);
  expect(world.calls.skip).toEqual([b.id, d.id]);
  expect(world.items.has(c.id)).toBe(false);
  expect(downstream).toEqual([["e"]]);
});

test("failures persist an error notification, toast, and mark the job errored", async () => {
  const { world, workflows, session } = await setup(makeNode("boom", { async run() { throw new Error("kaput"); } }));
  workflows.save(workflowOf("w", graphOf([["s", "source"], ["b", "boom"]], [["s", "b"]])));
  world.addItems(session.id, ["a"]);
  workflows.run("w", session.id);
  await world.jobs.settle();

  expect(world.jobs.submitted[0].state).toBe("error");
  expect(world.persisted[0].level).toBe("error");
  expect(world.persisted[0].message).toContain("kaput");
  expect(world.toasts.at(-1)?.level).toBe("error");
});

test("run rejects a duplicate for the same workflow and session with 409", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { world, workflows, session } = await setup(makeNode("slow", { async run(items) { await gate; return { items }; } }));
  world.addItems(session.id, ["a"]);
  workflows.save(workflowOf("w", graphOf([["s", "source"], ["l", "slow"]], [["s", "l"]])));
  workflows.run("w", session.id);
  let caught: unknown;
  try {
    workflows.run("w", session.id);
  } catch (error) {
    caught = error;
  }
  expect((caught as HttpError).status).toBe(409);
  release();
  await world.jobs.settle();
  expect(() => workflows.run("w", session.id)).not.toThrow();
  await world.jobs.settle();
});

test("run reports missing workflow and session as 404", async () => {
  const { workflows, session } = await setup();
  expect(() => workflows.run("nope", session.id)).toThrow(HttpError);
  workflows.save(workflowOf("w", graphOf([["s", "source"]], [])));
  expect(() => workflows.run("w", "ghost")).toThrow(HttpError);
});

// --- triggers ----------------------------------------------------------------------------

test("fire runs subscribed workflows of the session's project; item triggers pass itemId", async () => {
  const scoped: (string | undefined)[] = [];
  const { world, workflows, project, session } = await setup(
    makeNode("probe", { async run(items, context) { scoped.push(context.scopedItemId); return { items }; } }),
  );
  workflows.registerTrigger({ id: "item_opened", plugin: "test", label: "o", scope: "item" });
  workflows.registerTrigger({ id: "session_created", plugin: "test", label: "c", scope: "session" });
  const graph = graphOf([["s", "source"], ["p", "probe"]], [["s", "p"]]);
  workflows.save(workflowOf("here", graph, { triggers: ["item_opened", "session_created"], projectId: project.id }));
  workflows.save(workflowOf("elsewhere", graph, { triggers: ["item_opened"], projectId: "other" }));
  workflows.save(workflowOf("manual-only", graph));
  const [item] = world.addItems(session.id, ["a"]);

  workflows.fire({ trigger: "item_opened", sessionId: session.id, itemId: item.id });
  await world.jobs.settle();
  workflows.fire({ trigger: "session_created", sessionId: session.id, itemId: item.id });
  await world.jobs.settle();

  expect(world.jobs.submitted.length).toBe(2);
  expect(scoped).toEqual([item.id, undefined]);
});

test("labels applied by a workflow action do not re-fire item triggers", async () => {
  const { world, workflows, project, session } = await setup(
    makeNode("accept-all", { async run(items) { return { items: items.map((item) => ({ ...item, action: "accept" })) }; } }),
  );
  workflows.registerTrigger({ id: "item_accepted", plugin: "test", label: "a", scope: "item" });
  world.context.on("items/labeled", (item) => {
    workflows.fire({ trigger: "item_accepted", sessionId: item.sessionId, itemId: item.id });
  });
  const graph = graphOf([["s", "source"], ["a", "accept-all"]], [["s", "a"]]);
  workflows.save(workflowOf("acceptor", graph));
  workflows.save(workflowOf("listener", graph, { triggers: ["item_accepted"], projectId: project.id }));
  world.addItems(session.id, ["a", "b"]);

  workflows.run("acceptor", session.id);
  await world.jobs.settle();
  expect(world.jobs.submitted.length).toBe(1);
  expect(world.calls.confirm.length).toBe(2);
});

// --- dry run -----------------------------------------------------------------------------

test("dryRun counts the accepts split, simulates hooks and never calls run", async () => {
  let runCalls = 0;
  const counting = (type: string, overrides: Partial<NodeType> = {}) =>
    makeNode(type, { async run(items) { runCalls += 1; return { items }; }, ...overrides });
  const { world, workflows, session } = await setup(
    counting("embed", { label: "Embed", accepts: { embedded: false } }),
    counting("keep-two", { dryRun: (items) => items.slice(0, 2) }),
    counting("drop-all", { dryRun: () => [] }),
    counting("plain"),
  );
  world.addItems(session.id, ["a", "b", "c"]);
  world.addItems(session.id, ["d"], { embedded: true });

  const result = await workflows.dryRun(
    session.id,
    graphOf([["s", "source"], ["e", "embed"], ["k", "keep-two"], ["x", "drop-all"], ["p", "plain"]],
      [["s", "e"], ["e", "k"], ["k", "x"], ["x", "p"]]),
  );
  expect(runCalls).toBe(0);
  expect(result.entities).toBe(4);
  const byId = Object.fromEntries(result.nodes.map((node) => [node.id, node]));
  expect(byId.s).toMatchObject({ in: 4, matched: 4, out: 4 });
  expect(byId.e).toMatchObject({ in: 4, matched: 3, passthrough: 1, out: 4 });
  expect(byId.k).toMatchObject({ in: 4, matched: 4, out: 2 });
  expect(byId.x).toMatchObject({ in: 2, out: 0, note: "this node empties the stream" });
  expect(byId.p).toMatchObject({ in: 0, matched: 0, out: 0 });
});

test("dryRun explains a node that matches nothing and returns only the report for invalid graphs", async () => {
  const { world, workflows, session } = await setup(makeNode("embed", { label: "Embed", accepts: { embedded: false } }));
  world.addItems(session.id, ["a"], { embedded: true });
  const result = await workflows.dryRun(session.id, graphOf([["s", "source"], ["e", "embed"]], [["s", "e"]]));
  expect(result.nodes[1].note).toBe("Embed skipped - none of the 1 items are unembedded");

  const invalid = await workflows.dryRun(session.id, graphOf([["x", "teleport"]], []));
  expect(invalid.report.ok).toBe(false);
  expect(invalid.nodes).toEqual([]);
  expect(invalid.entities).toBe(0);
});

test("dry-run and run routes work by graph or workflowId", async () => {
  const { world, workflows, session } = await setup();
  world.addItems(session.id, ["a"]);
  const graph = graphOf([["s", "source"]], []);
  workflows.save(workflowOf("w", graph));
  const byGraph = (await world.callRoute("POST", "/api/sessions/:id/workflow/dry-run", { params: { id: session.id }, body: { graph } })) as { entities: number };
  const byId = (await world.callRoute("POST", "/api/sessions/:id/workflow/dry-run", { params: { id: session.id }, body: { workflowId: "w" } })) as { entities: number };
  expect(byGraph.entities).toBe(1);
  expect(byId.entities).toBe(1);
  const job = (await world.callRoute("POST", "/api/sessions/:id/workflow/:workflowId", { params: { id: session.id, workflowId: "w" } })) as { type: string };
  expect(job.type).toBe("workflow");
  await world.jobs.settle();
});
