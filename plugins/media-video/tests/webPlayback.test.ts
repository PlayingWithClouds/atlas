import { expect, test } from "bun:test";
import type { Item, Session } from "@atlas/contracts";
import { createPlayerBudget } from "../src/web/playerBudget";
import { planPlayback } from "../src/web/playback";

const urlOf = (path: string) => `/api${path}`;

function sessionWith(meta: Record<string, unknown>): Session {
  return {
    id: "s",
    projectId: "p",
    label: "s",
    source: { plugin: "x", kind: "k", params: {} },
    producing: false,
    created: "",
    meta,
  };
}

function itemWith(span?: { start: number; end: number }): Item {
  return { id: "i1", sessionId: "s", index: 0, ref: "v", mediaKind: "video", status: "pending", annotations: [], embedded: false, span, meta: {} };
}

test("span items stream the whole video and loop inside the span", () => {
  const plan = planPlayback(itemWith({ start: 4, end: 9 }), sessionWith({}), urlOf);
  expect(plan).toEqual({ src: "/api/items/i1/video", start: 4, end: 9 });
});

test("clip playback and forced fallback use the encoded clip from zero", () => {
  const expected = { src: "/api/items/i1/media", start: 0, end: 5 };
  expect(planPlayback(itemWith({ start: 4, end: 9 }), sessionWith({ playback: "clip" }), urlOf)).toEqual(expected);
  expect(planPlayback(itemWith({ start: 4, end: 9 }), sessionWith({}), urlOf, true)).toEqual(expected);
});

test("items without a span play the media route with an open end", () => {
  expect(planPlayback(itemWith(), sessionWith({}), urlOf)).toEqual({ src: "/api/items/i1/media", start: 0, end: undefined });
});

test("player budget refuses beyond the limit and frees slots on release", () => {
  const budget = createPlayerBudget(2);
  expect(budget.acquire()).toBe(true);
  expect(budget.acquire()).toBe(true);
  expect(budget.acquire()).toBe(false);
  budget.release();
  expect(budget.acquire()).toBe(true);
  expect(budget.inUse()).toBe(2);
});
