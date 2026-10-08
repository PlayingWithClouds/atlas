import { expect, test } from "bun:test";
import {
  boundsOf,
  fromAnnotation,
  hitTest,
  isLargeEnough,
  moveRegion,
  normalizeDraftBox,
  pointInPolygon,
  toAnnotation,
  toNormalizedPoint,
  unlabeledRegions,
  zoomAround,
} from "../../src/web/regionGeometry";
import type { Region } from "../../src/web/regionGeometry";

test("pixel positions normalize to 0..1 and clamp to the image", () => {
  expect(toNormalizedPoint(500, 250, 1000, 500)).toEqual([0.5, 0.5]);
  expect(toNormalizedPoint(-10, 2000, 1000, 500)).toEqual([0, 1]);
});

test("a drag in any direction becomes a positive box inside the image", () => {
  const box = normalizeDraftBox([0.8, 0.9], [0.2, 1.4]);
  expect(box.x).toBeCloseTo(0.2);
  expect(box.y).toBeCloseTo(0.9);
  expect(box.w).toBeCloseTo(0.6);
  expect(box.h).toBeCloseTo(0.1);
  expect(isLargeEnough({ x: 0, y: 0, w: 0.001, h: 0.5 })).toBe(false);
});

test("annotations round-trip and use the single-label server shape", () => {
  const region: Region = { id: "r", type: "rect", x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: "cat" };
  const annotation = toAnnotation(region);
  expect(annotation).toEqual({ type: "rect", value: { x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: "cat" } });
  expect(fromAnnotation(annotation, "r")).toEqual(region);
  expect(fromAnnotation({ type: "tag", value: { labels: ["a"] } }, "x")).toBeUndefined();
});

test("moving keeps the region inside the image", () => {
  const rect: Region = { id: "r", type: "rect", x: 0.8, y: 0.1, w: 0.2, h: 0.2, label: "" };
  const moved = moveRegion(rect, 0.5, -0.5);
  expect(moved).toMatchObject({ x: 0.8, y: 0 });

  const polygon: Region = { id: "p", type: "polygon", points: [[0.1, 0.1], [0.3, 0.1], [0.2, 0.3]], label: "" };
  expect(boundsOf(moveRegion(polygon, -1, 0)).x).toBe(0);
});

test("hit testing finds the topmost region and handles polygons", () => {
  const regions: Region[] = [
    { id: "back", type: "rect", x: 0, y: 0, w: 1, h: 1, label: "" },
    { id: "front", type: "keypoint", x: 0.5, y: 0.5, label: "" },
  ];
  expect(hitTest(regions, [0.505, 0.5])?.id).toBe("front");
  expect(hitTest(regions, [0.9, 0.9])?.id).toBe("back");
  expect(pointInPolygon([0.5, 0.2], [[0, 0], [1, 0], [0.5, 1]])).toBe(true);
  expect(pointInPolygon([0.1, 0.9], [[0, 0], [1, 0], [0.5, 1]])).toBe(false);
});

test("zoom keeps the anchor fixed and clamps the scale", () => {
  const zoomed = zoomAround({ scale: 1, translateX: 0, translateY: 0 }, 100, 50, 2);
  expect(zoomed).toEqual({ scale: 2, translateX: -100, translateY: -50 });
  expect(zoomAround(zoomed, 0, 0, 0.1).scale).toBe(1);
  expect(zoomAround(zoomed, 0, 0, 100).scale).toBe(8);
});

test("unlabeled regions are reported before saving", () => {
  const regions: Region[] = [
    { id: "1", type: "keypoint", x: 0, y: 0, label: "" },
    { id: "2", type: "keypoint", x: 0, y: 0, label: "cat" },
  ];
  expect(unlabeledRegions(regions).map((region) => region.id)).toEqual(["1"]);
});
