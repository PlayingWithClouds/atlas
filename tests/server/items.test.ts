import { expect, test } from "bun:test";
import { parseSpanRef } from "../../packages/contracts/src/index";
import { projectConfig } from "./fakes";
import { startHost } from "./helpers";

async function setup() {
  const host = await startHost();
  const project = host.context.projects.create("p", projectConfig());
  const session = host.context.items.createSession({
    projectId: project.id,
    label: "s",
    source: { plugin: "x", kind: "k", params: {} },
  });
  return { host, items: host.context.items, session };
}

test("idx is unique and monotonic, duplicate refs are skipped", async () => {
  const { host, items, session } = await setup();
  const first = items.append(session.id, [
    { ref: "a", mediaKind: "m" },
    { ref: "b", mediaKind: "m" },
    { ref: "a", mediaKind: "m" },
  ]);
  const second = items.append(session.id, [
    { ref: "b", mediaKind: "m" },
    { ref: "c", mediaKind: "m" },
  ]);
  expect(first.map((item) => item.index)).toEqual([0, 1]);
  expect(second.map((item) => [item.ref, item.index])).toEqual([["c", 2]]);
  expect(items.list(session.id).map((item) => item.ref)).toEqual(["a", "b", "c"]);
  items.remove(first[0].id);
  expect(items.append(session.id, [{ ref: "d", mediaKind: "m" }])[0].index).toBe(3);
  await host.stop();
});

test("span items round-trip through the span ref and setSpan clears embedded", async () => {
  const { host, items, session } = await setup();
  const [item] = items.append(session.id, [{ ref: "video", mediaKind: "m", span: { start: 1, end: 2.5 } }]);
  expect(parseSpanRef(item.ref)).toEqual({ ref: "video", span: { start: 1, end: 2.5 } });
  expect(item.span).toEqual({ start: 1, end: 2.5 });
  items.setEmbedded([item.id], true);
  expect(items.get(item.id)?.embedded).toBe(true);
  const moved = items.setSpan(item.id, { start: 2, end: 4 });
  expect(parseSpanRef(moved.ref)).toEqual({ ref: "video", span: { start: 2, end: 4 } });
  expect(moved.embedded).toBe(false);
  await host.stop();
});

test("removing a session cascades and emits events; labeledInProject joins sessions", async () => {
  const { host, items, session } = await setup();
  const removed: string[] = [];
  host.context.on("session/removed", (sessionId) => {
    removed.push(sessionId);
  });
  const [item] = items.append(session.id, [{ ref: "a", mediaKind: "m" }]);
  items.setAnnotations(item.id, [], "labeled");
  expect(items.labeledInProject(session.projectId).map((labeled) => labeled.id)).toEqual([item.id]);
  items.removeSession(session.id);
  expect(removed).toEqual([session.id]);
  expect(items.get(item.id)).toBeUndefined();
  await host.stop();
});

test("compact renumbers idx to 0..n-1 in order and later appends continue after it", async () => {
  const { host, items, session } = await setup();
  const added = items.append(
    session.id,
    ["a", "b", "c", "d", "e"].map((ref) => ({ ref, mediaKind: "m" })),
  );
  items.remove(added[1].id);
  items.remove(added[3].id);
  items.compact(session.id);
  expect(items.list(session.id).map((item) => [item.ref, item.index])).toEqual([
    ["a", 0],
    ["c", 1],
    ["e", 2],
  ]);
  expect(items.append(session.id, [{ ref: "f", mediaKind: "m" }])[0].index).toBe(3);
  items.compact(session.id);
  expect(items.list(session.id).map((item) => item.index)).toEqual([0, 1, 2, 3]);
  await host.stop();
});
