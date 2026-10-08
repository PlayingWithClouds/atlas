import { expect, test } from "bun:test";
import { parseMessages, reduceEntries, takeEvents } from "../../src/web/entries";
import type { Entry } from "../../src/web/entries";

test("tool results attach to the latest unanswered tool call", () => {
  let entries: Entry[] = [];
  entries = reduceEntries(entries, { kind: "tool", tool: "a", detail: "x=1" });
  entries = reduceEntries(entries, { kind: "tool", tool: "b", detail: "" });
  entries = reduceEntries(entries, { kind: "tool_result", tool: "b", detail: "done b" });
  entries = reduceEntries(entries, { kind: "tool_result", tool: "a", detail: "done a" });
  expect(entries).toEqual([
    { kind: "tool", tool: "a", detail: "x=1", result: "done a" },
    { kind: "tool", tool: "b", detail: "", result: "done b" },
  ]);
});

test("messages, thinking and errors become entries", () => {
  let entries: Entry[] = [];
  entries = reduceEntries(entries, { kind: "thinking", content: "hmm" });
  entries = reduceEntries(entries, { kind: "message", content: "answer" });
  entries = reduceEntries(entries, { kind: "error" });
  expect(entries.map((entry) => entry.kind)).toEqual(["thinking", "assistant", "error"]);
  expect((entries[2] as { text: string }).text).toBe("something went wrong");
});

test("takeEvents keeps a partial frame in the buffer", () => {
  const first = takeEvents('data: {"kind":"message","content":"a"}\n\ndata: {"kind":"mess');
  expect(first.events).toEqual([{ kind: "message", content: "a" }]);
  const second = takeEvents(first.rest + 'age","content":"b"}\n\ndata: not json\n\n');
  expect(second.events).toEqual([{ kind: "message", content: "b" }]);
  expect(second.rest).toBe("");
});

test("parseMessages tolerates garbage", () => {
  expect(parseMessages(undefined)).toEqual([]);
  expect(parseMessages("not json")).toEqual([]);
  expect(parseMessages('{"a":1}')).toEqual([]);
  expect(parseMessages('[{"role":"user","content":"x"}]')).toEqual([{ role: "user", content: "x" }]);
});
