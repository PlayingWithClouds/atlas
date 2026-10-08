import { expect, test } from "bun:test";
import { mergeAtoms, planAtoms, planSpans, unusedAtoms } from "../src/segment/plan";
import type { SpanPlan } from "../src/segment/plan";
import { segmentFingerprint, settingsOf } from "../src/segment/settings";
import { nearestCut, snapToCuts } from "../src/trim";

function rangesOf(spans: SpanPlan[]): [number, number][] {
  return spans.map((span) => [span.start, span.end]);
}

test("planSpans lays out fixed windows with a clamped last window", () => {
  expect(planSpans("v.mp4", 10, 4, 4)).toEqual([
    { ref: "v.mp4#t=0.000,4.000", start: 0, end: 4 },
    { ref: "v.mp4#t=4.000,8.000", start: 4, end: 8 },
    { ref: "v.mp4#t=8.000,10.000", start: 8, end: 10 },
  ]);
});

test("planSpans supports overlapping strides and gaps", () => {
  const overlapping = planSpans("v.mp4", 5, 4, 2);
  expect(overlapping.length).toBe(3);
  expect(rangesOf(overlapping)[1]).toEqual([2, 5]);
  expect(rangesOf(planSpans("v.mp4", 9, 2, 5))).toEqual([[0, 2], [5, 7]]);
  expect(rangesOf(planSpans("v.mp4", 3, 10, 10))).toEqual([[0, 3]]);
});

test("planSpans rejects bad input", () => {
  expect(planSpans("", 10, 4, 4)).toEqual([]);
  expect(planSpans("v.mp4", 0, 4, 4)).toEqual([]);
  expect(planSpans("v.mp4", 10, 0, 4)).toEqual([]);
  expect(planSpans("v.mp4", 10, 4, 0)).toEqual([]);
});

test("planAtoms splits at cuts and subdivides long shots into equal parts", () => {
  expect(rangesOf(planAtoms("v.mp4", 10, [3, 7], 4))).toEqual([[0, 3], [3, 7], [7, 10]]);
  expect(rangesOf(planAtoms("v.mp4", 9, [], 4))).toEqual([[0, 3], [3, 6], [6, 9]]);
});

test("planAtoms ignores cuts that are unusable", () => {
  expect(rangesOf(planAtoms("v.mp4", 8, [0, 4, 4, 20], 8))).toEqual([[0, 4], [4, 8]]);
});

test("planAtoms rejects bad input", () => {
  expect(planAtoms("", 10, [], 4)).toEqual([]);
  expect(planAtoms("v.mp4", 0, [], 4)).toEqual([]);
  expect(planAtoms("v.mp4", 10, [], 0)).toEqual([]);
});

test("mergeAtoms joins similar neighbours", () => {
  const atoms = planAtoms("v.mp4", 8, [2, 4, 6], 2);
  // The first three atoms are one act shot from three angles; the last is a new act.
  expect(rangesOf(mergeAtoms("v.mp4", atoms, [0.97, 0.95, 0.2], 0.9, 1, 8))).toEqual([[0, 6], [6, 8]]);
});

test("mergeAtoms stops at the maximum length", () => {
  const atoms = planAtoms("v.mp4", 8, [2, 4, 6], 2);
  expect(rangesOf(mergeAtoms("v.mp4", atoms, [0.99, 0.99, 0.99], 0.9, 1, 4))).toEqual([[0, 4], [4, 8]]);
});

test("mergeAtoms absorbs a short clip into its better match", () => {
  const atoms = planAtoms("v.mp4", 9, [4, 5], 4);
  expect(rangesOf(mergeAtoms("v.mp4", atoms, [0.3, 0.95], 0.99, 2, 9))).toEqual([[0, 4], [4, 9]]);
});

test("mergeAtoms keeps a short clip that has no room to go", () => {
  const atoms = planAtoms("v.mp4", 9, [4, 5], 4);
  expect(rangesOf(mergeAtoms("v.mp4", atoms, [0.95, 0.95], 0.99, 2, 4))).toEqual([[0, 4], [4, 5], [5, 9]]);
});

test("mergeAtoms without scores changes nothing", () => {
  const atoms = planAtoms("v.mp4", 8, [2, 4, 6], 2);
  expect(rangesOf(mergeAtoms("v.mp4", atoms, [], 0.9, 0, 8))).toEqual(rangesOf(atoms));
  expect(rangesOf(mergeAtoms("v.mp4", atoms, [0.99, 0.99, 0.99], 0, 0, 8))).toEqual(rangesOf(atoms));
  // A short score list must not shift boundaries it does not cover.
  expect(rangesOf(mergeAtoms("v.mp4", atoms, [0.99], 0.9, 0, 8))).toEqual([[0, 4], [4, 6], [6, 8]]);
});

test("mergeAtoms refs match ranges, and an empty plan stays empty", () => {
  const atoms = planAtoms("v.mp4", 8, [4], 4);
  const merged = mergeAtoms("v.mp4", atoms, [0.99], 0.9, 1, 8);
  expect(merged.map((span) => span.ref)).toEqual(["v.mp4#t=0.000,8.000"]);
  expect(mergeAtoms("v.mp4", [], [], 0.9, 2, 4)).toEqual([]);
});

test("unusedAtoms lists atoms whose ref did not survive the merge", () => {
  const atoms = planAtoms("v.mp4", 8, [4], 4);
  const merged = mergeAtoms("v.mp4", atoms, [0.99], 0.9, 1, 8);
  expect(unusedAtoms(atoms, merged).map((atom) => atom.ref)).toEqual(atoms.map((atom) => atom.ref));
  expect(unusedAtoms(atoms, atoms)).toEqual([]);
});

test("fingerprint tracks only the settings of its own mode", () => {
  const scenes = settingsOf({ mode: "scenes", window: 8, stride: 4, minLen: 2, cutScore: 0.3, merge: 0.9 });
  expect(segmentFingerprint(scenes)).toBe(segmentFingerprint({ ...scenes, stride: 1 }));
  expect(segmentFingerprint(scenes)).not.toBe(segmentFingerprint({ ...scenes, cutScore: 0.4 }));
  const fixed = settingsOf({ mode: "fixed", window: 8, stride: 4 });
  expect(segmentFingerprint(fixed)).not.toBe(segmentFingerprint(scenes));
  expect(segmentFingerprint(fixed)).not.toBe(segmentFingerprint({ ...fixed, stride: 2 }));
});

test("settingsOf applies the node defaults", () => {
  expect(settingsOf({})).toEqual({ mode: "fixed", window: 4, stride: 4, minLength: 2, cutScore: 0.3, merge: 0.9 });
});

test("nearestCut snaps within tolerance and prefers the closest cut", () => {
  const cuts = [2.1, 7.9, 12];
  expect(nearestCut(2, cuts, 0.5)).toBe(2.1);
  expect(nearestCut(5, cuts, 0.5)).toBe(5);
  expect(nearestCut(7.95, cuts, 4)).toBe(7.9);
});

test("snapToCuts moves edges independently", () => {
  const cuts = [2.1, 7.9];
  expect(snapToCuts({ start: 2, end: 8 }, cuts, 30, 0.5, 2)).toEqual({ start: 2.1, end: 7.9 });
  expect(snapToCuts({ start: 2, end: 6 }, cuts, 30, 0.5, 2)).toEqual({ start: 2.1, end: 6 });
});

test("snapToCuts refuses to undercut the minimum length", () => {
  expect(snapToCuts({ start: 4, end: 5 }, [3.9, 5.1], 30, 1, 2)).toEqual({ start: 4, end: 5 });
});

test("snapToCuts clamps to the duration and is the identity without cuts", () => {
  expect(snapToCuts({ start: 6, end: 11 }, [10.5], 10, 1, 2)).toEqual({ start: 6, end: 10 });
  expect(snapToCuts({ start: 4, end: 8 }, [], 30, 1, 2)).toEqual({ start: 4, end: 8 });
});
