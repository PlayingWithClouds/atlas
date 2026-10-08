import { expect, test } from "bun:test";
import { classForDigit, gridActionForKey, itemActionForKey } from "../../src/web/keyboardMap";

const CLASSES = ["cat", "dog", "bird"];
const press = (key: string, shiftKey = false) => ({ key, shiftKey });

test("digits map to classes by flat position and ignore unknown slots", () => {
  expect(classForDigit("1", CLASSES)).toBe("cat");
  expect(classForDigit("3", CLASSES)).toBe("bird");
  expect(classForDigit("4", CLASSES)).toBeUndefined();
  expect(classForDigit("0", CLASSES)).toBeUndefined();
  expect(classForDigit("a", CLASSES)).toBeUndefined();
});

test("item keys resolve to labeler actions", () => {
  expect(itemActionForKey(press("2"), CLASSES)).toEqual({ kind: "toggleClass", name: "dog" });
  expect(itemActionForKey(press("Enter"), CLASSES)).toEqual({ kind: "confirm" });
  expect(itemActionForKey(press("s"), CLASSES)).toEqual({ kind: "skip" });
  expect(itemActionForKey(press("S", true), CLASSES)).toEqual({ kind: "skip" });
  expect(itemActionForKey(press("C", true), CLASSES)).toEqual({ kind: "reapplyLast" });
  expect(itemActionForKey(press("D", true), CLASSES)).toEqual({ kind: "delete" });
  expect(itemActionForKey(press("ArrowLeft"), CLASSES)).toEqual({ kind: "previous" });
  expect(itemActionForKey(press("ArrowRight"), CLASSES)).toEqual({ kind: "next" });
});

test("unshifted c and d do nothing, and command modifiers never trigger actions", () => {
  expect(itemActionForKey(press("c"), CLASSES)).toBeUndefined();
  expect(itemActionForKey(press("d"), CLASSES)).toBeUndefined();
  expect(itemActionForKey({ key: "s", shiftKey: false, ctrlKey: true }, CLASSES)).toBeUndefined();
});

test("grid shortcuts need a selection", () => {
  expect(gridActionForKey(press("l"), false)).toBeUndefined();
  expect(gridActionForKey(press("l"), true)).toEqual({ kind: "assign" });
  expect(gridActionForKey(press("S", true), true)).toEqual({ kind: "skip" });
  expect(gridActionForKey(press("D", true), true)).toEqual({ kind: "delete" });
  expect(gridActionForKey(press("Escape"), true)).toEqual({ kind: "clear" });
  expect(gridActionForKey(press("s"), true)).toBeUndefined();
});
