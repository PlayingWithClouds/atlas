import { expect, test } from "bun:test";
import type { Item } from "@atlas/contracts";
import {
  annotationsWithTags,
  initialSelection,
  labelsAfterBatch,
  recallTags,
  rememberTags,
  searchClasses,
  tagsOnEvery,
  tagsOnSome,
} from "../../src/web/itemTags";

function itemWith(id: string, labels: string[]): Item {
  const annotations = labels.length > 0 ? [{ type: "tag", value: { labels } }] : [];
  return { id, sessionId: "s", index: 0, ref: id, mediaKind: "image", status: "pending", annotations, embedded: false, meta: {} };
}

test("tagsOnEvery and tagsOnSome split shared from partial tags", () => {
  const items = [itemWith("1", ["a", "b"]), itemWith("2", ["a", "c"])];
  const common = tagsOnEvery(items);
  expect([...common]).toEqual(["a"]);
  expect([...tagsOnSome(items, common)].sort()).toEqual(["b", "c"]);
  expect(tagsOnEvery([]).size).toBe(0);
});

test("batch merge adds, removes seeded-then-unchecked tags, or replaces", () => {
  const seeded = new Set(["a"]);
  expect(labelsAfterBatch(["a", "x"], { chosen: new Set(["b"]), seeded, replace: false }).sort()).toEqual(["b", "x"]);
  expect(labelsAfterBatch(["x"], { chosen: new Set(["a", "b"]), seeded, replace: false }).sort()).toEqual(["a", "b", "x"]);
  expect(labelsAfterBatch(["x"], { chosen: new Set(["b"]), seeded, replace: true })).toEqual(["b"]);
});

test("annotationsWithTags replaces only the tag annotation", () => {
  const item = itemWith("1", ["a"]);
  item.annotations.push({ type: "rect", value: {} });
  expect(annotationsWithTags(item, ["b"])).toEqual([
    { type: "rect", value: {} },
    { type: "tag", value: { labels: ["b"] } },
  ]);
  expect(annotationsWithTags(item, [])).toEqual([{ type: "rect", value: {} }]);
});

test("initialSelection prefers existing labels over suggestions", () => {
  expect([...initialSelection(["a"], { b: 0.9 }, 0.5)]).toEqual(["a"]);
  expect([...initialSelection([], { b: 0.9, c: 0.2 }, 0.5)]).toEqual(["b"]);
});

test("searchClasses is case insensitive, ranked and capped at nine", () => {
  const names = Array.from({ length: 12 }, (_, index) => `Tag${index}`);
  expect(searchClasses(names, "tag")).toHaveLength(9);
  expect(searchClasses(["Apple", "Pineapple"], "APPLE", { Pineapple: 0.9 })).toEqual(["Pineapple", "Apple"]);
  expect(searchClasses(names, "  ")).toEqual([]);
});

test("remembered tags are copied", () => {
  const tags = ["a"];
  rememberTags(tags);
  tags.push("b");
  expect(recallTags()).toEqual(["a"]);
});
