import { expect, test } from "bun:test";
import { resolveClick, selectRange, toggleId } from "../../src/web/selection";

const IDS = ["a", "b", "c", "d", "e"];
const PLAIN = { shiftKey: false, ctrlKey: false, metaKey: false };

test("selectRange is inclusive and direction independent", () => {
  expect([...selectRange(IDS, 1, 3)]).toEqual(["b", "c", "d"]);
  expect([...selectRange(IDS, 3, 1)]).toEqual(["b", "c", "d"]);
  expect([...selectRange(IDS, 2, 2)]).toEqual(["c"]);
});

test("toggleId does not mutate its input", () => {
  const original = new Set(["a"]);
  expect([...toggleId(original, "b")]).toEqual(["a", "b"]);
  expect([...toggleId(original, "a")]).toEqual([]);
  expect([...original]).toEqual(["a"]);
});

test("plain click opens when nothing is selected and toggles otherwise", () => {
  const empty = { selectedIds: new Set<string>(), anchorPosition: null };
  expect(resolveClick(IDS, 1, empty, PLAIN)).toEqual({ kind: "open" });

  const withSelection = { selectedIds: new Set(["a"]), anchorPosition: 0 };
  const outcome = resolveClick(IDS, 2, withSelection, PLAIN);
  expect(outcome.kind).toBe("select");
  if (outcome.kind === "select") {
    expect([...outcome.state.selectedIds]).toEqual(["a", "c"]);
    expect(outcome.state.anchorPosition).toBe(2);
  }
});

test("ctrl and meta toggle even without an existing selection", () => {
  const empty = { selectedIds: new Set<string>(), anchorPosition: null };
  for (const modifiers of [{ ...PLAIN, ctrlKey: true }, { ...PLAIN, metaKey: true }]) {
    const outcome = resolveClick(IDS, 3, empty, modifiers);
    expect(outcome.kind === "select" && [...outcome.state.selectedIds]).toEqual(["d"]);
  }
});

test("shift extends from the anchor and starts a selection without one", () => {
  const anchored = { selectedIds: new Set(["b"]), anchorPosition: 1 };
  const range = resolveClick(IDS, 3, anchored, { ...PLAIN, shiftKey: true });
  expect(range.kind === "select" && [...range.state.selectedIds]).toEqual(["b", "c", "d"]);
  expect(range.kind === "select" && range.state.anchorPosition).toBe(1);

  const fresh = resolveClick(IDS, 4, { selectedIds: new Set(), anchorPosition: null }, { ...PLAIN, shiftKey: true });
  expect(fresh.kind === "select" && [...fresh.state.selectedIds]).toEqual(["e"]);
});
