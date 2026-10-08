import { expect, test } from "bun:test";
import type { Annotation, WorkItem } from "@atlas/contracts";
import type { NodeRunContext } from "@atlas/contracts/server";
import { actionNode } from "../src/nodes/action";
import { applyFilter, labelsOf, predicateFrom } from "../src/nodes/filter";
import { createNotifyNode } from "../src/nodes/notify";
import { createSampleNode, shuffled, takeFirst } from "../src/nodes/sample";
import { sessionItemsNode } from "../src/nodes/sessionItems";
import { renderTemplate } from "../src/template";

function clip(ref: string, extra: Partial<WorkItem> = {}): WorkItem {
  return { ref, status: "pending", embedded: false, annotations: [], ...extra };
}

function refsOf(items: WorkItem[]): string[] {
  return items.map((item) => item.ref);
}

function contextWith(params: Record<string, unknown>, extra: Partial<NodeRunContext> = {}): NodeRunContext {
  return {
    project: { id: "p", name: "P", config: {} as never, created: "", updated: "" },
    session: { id: "s1", label: "My session", projectId: "p", source: { plugin: "", kind: "", params: {} }, producing: false, created: "", meta: {} },
    classes: [],
    params,
    job: {} as never,
    inputs: [],
    sessionItems: () => [],
    ...extra,
  };
}

const tag = (...labels: string[]): Annotation => ({ type: "tag", value: { labels } });

// --- filter ------------------------------------------------------------------------------

test("filter on text fields: is / not", () => {
  const items = [clip("a", { status: "pending" }), clip("b", { status: "labeled" })];
  expect(refsOf(applyFilter(items, { field: "status", op: "is", value: "labeled" }))).toEqual(["b"]);
  expect(refsOf(applyFilter(items, { field: "status", op: "not", value: "labeled" }))).toEqual(["a"]);
});

test("filter on boolean fields compares their text form", () => {
  const items = [clip("a", { embedded: true }), clip("b", { embedded: false })];
  expect(refsOf(applyFilter(items, { field: "embedded", op: "is", value: "true" }))).toEqual(["a"]);
});

test("filter on duration derives it from the span", () => {
  const items = [
    clip("short", { span: { start: 0, end: 2 } }),
    clip("long", { span: { start: 0, end: 10 } }),
    clip("still"),
  ];
  expect(refsOf(applyFilter(items, { field: "duration", op: "gt", value: "5" }))).toEqual(["long"]);
  expect(refsOf(applyFilter(items, { field: "duration", op: "lt", value: "5" }))).toEqual(["short"]);
});

test("a missing field never matches, whichever way the condition points", () => {
  const items = [clip("scored", { confidence: 0.2 }), clip("unscored")];
  expect(refsOf(applyFilter(items, { field: "confidence", op: "lt", value: "0.5" }))).toEqual(["scored"]);
  expect(refsOf(applyFilter(items, { field: "confidence", op: "gt", value: "0.5" }))).toEqual([]);
  expect(refsOf(applyFilter(items, { field: "confidence", op: "not", value: "0.9" }))).toEqual(["scored"]);
  expect(refsOf(applyFilter(items, { field: "confidence", op: "is", value: "0.2" }))).toEqual(["scored"]);
  expect(applyFilter(items, { field: "confidence", op: "gt", value: "abc" })).toEqual([]);
});

test("filter on annotation type and label", () => {
  const items = [clip("tagged", { annotations: [tag("anal", "other")] }), clip("bare")];
  expect(refsOf(applyFilter(items, { field: "annotation", op: "is", value: "tag" }))).toEqual(["tagged"]);
  expect(refsOf(applyFilter(items, { field: "annotation", op: "not", value: "tag" }))).toEqual(["bare"]);
  expect(refsOf(applyFilter(items, { field: "label", op: "is", value: "anal" }))).toEqual(["tagged"]);
  expect(refsOf(applyFilter(items, { field: "label", op: "not", value: "anal" }))).toEqual(["bare"]);
});

test("labelsOf reads labels arrays and single labels", () => {
  expect(labelsOf([tag("a", "b"), { type: "x", value: { label: "c" } }])).toEqual(["a", "b", "c"]);
});

test("filter node uses defaults and doubles as its own dry run", async () => {
  expect(predicateFrom({})).toEqual({ field: "status", op: "is", value: "" });
  const { filterNode } = await import("../src/nodes/filter");
  const items = [clip("a"), clip("b", { status: "skipped" })];
  const context = contextWith({ field: "status", op: "is", value: "pending" });
  expect(refsOf((await filterNode.run(items, context)).items)).toEqual(["a"]);
  expect(refsOf(filterNode.dryRun?.(items, context) as WorkItem[])).toEqual(["a"]);
});

// --- sample ------------------------------------------------------------------------------

test("takeFirst keeps everything for count 0 or beyond the end", () => {
  const items = [clip("a"), clip("b"), clip("c")];
  expect(takeFirst(items, 0)).toHaveLength(3);
  expect(takeFirst(items, 99)).toHaveLength(3);
  expect(refsOf(takeFirst(items, 2))).toEqual(["a", "b"]);
});

test("shuffled keeps every item and does not mutate its input", () => {
  const items = [clip("a"), clip("b"), clip("c"), clip("d")];
  const result = shuffled(items);
  expect(refsOf(result).sort()).toEqual(["a", "b", "c", "d"]);
  expect(refsOf(items)).toEqual(["a", "b", "c", "d"]);
  expect(refsOf(shuffled(items, () => 0))).not.toEqual(["a", "b", "c", "d"]);
});

test("sample natural order truncates; random keeps count; uncertain follows the ranker", async () => {
  const ranked: string[][] = [];
  const node = createSampleNode(async (refs) => {
    ranked.push(refs);
    return ["c", "a"];
  });
  const items = [clip("a"), clip("b"), clip("c")];
  expect(refsOf((await node.run(items, contextWith({ order: "natural", count: 2 }))).items)).toEqual(["a", "b"]);
  expect((await node.run(items, contextWith({ order: "random", count: 2 }))).items).toHaveLength(2);
  const uncertain = await node.run(items, contextWith({ order: "uncertain", count: 0 }));
  expect(refsOf(uncertain.items)).toEqual(["c", "a", "b"]);
  expect(ranked).toEqual([["a", "b", "c"]]);
  expect(refsOf(node.dryRun?.(items, contextWith({ count: 1 })) as WorkItem[])).toEqual(["a"]);
});

test("sample uncertain falls back to natural order when ranking fails", async () => {
  const node = createSampleNode(async () => {
    throw new Error("model not loaded");
  });
  const items = [clip("a"), clip("b")];
  const result = await node.run(items, contextWith({ order: "uncertain" }));
  expect(refsOf(result.items)).toEqual(["a", "b"]);
});

// --- action, session-items, notify -------------------------------------------------------

test("action sets the reserved action field without touching other fields", async () => {
  const result = await actionNode.run([clip("a")], contextWith({ action: "reject" }));
  expect(result.items[0]).toMatchObject({ ref: "a", action: "reject", status: "pending" });
  expect((await actionNode.run([clip("a")], contextWith({}))).items[0].action).toBe("accept");
});

test("session-items reads the session and narrows to the scoped item", async () => {
  const all = [clip("a", { itemId: "i1" }), clip("b", { itemId: "i2" })];
  const unscoped = await sessionItemsNode.run([], contextWith({}, { sessionItems: () => all }));
  expect(refsOf(unscoped.items)).toEqual(["a", "b"]);
  const scoped = await sessionItemsNode.run([], contextWith({}, { sessionItems: () => all, scopedItemId: "i2" }));
  expect(refsOf(scoped.items)).toEqual(["b"]);
});

test("notify renders count, items.length and session.label, toast vs persistent", async () => {
  const toasts: string[] = [];
  const persisted: string[] = [];
  const node = createNotifyNode({
    toast: (input) => toasts.push(input.message),
    persist: (input) => {
      persisted.push(input.message);
      return {} as never;
    },
    list: () => [],
    dismiss: () => {},
    clear: () => {},
  });
  const items = [clip("a"), clip("b")];
  const template = "{{count}} of {{items.length}} in {{session.label}}";
  await node.run(items, contextWith({ message: template }));
  await node.run(items, contextWith({ message: template, kind: "persistent" }));
  expect(toasts).toEqual(["2 of 2 in My session"]);
  expect(persisted).toEqual(["2 of 2 in My session"]);
});

test("templates keep the raw text on error and render missing values as empty", () => {
  expect(renderTemplate("broken {{#if}}", {})).toBe("broken {{#if}}");
  expect(renderTemplate("open {{count", { count: 1 })).toBe("open {{count");
  expect(renderTemplate("x{{missing.deep}}y {{count}}", { count: 3 })).toBe("xy 3");
  expect(renderTemplate("{{ session.id }}", { session: { id: "s" } })).toBe("s");
});
