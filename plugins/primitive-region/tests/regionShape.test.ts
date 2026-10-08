import { expect, test } from "bun:test";
import { regionPrimitives } from "../src/server";
import { toAnnotation } from "../src/web/regionGeometry";
import type { Region } from "../src/web/regionGeometry";

test("saved region annotations pass the server primitives unchanged", () => {
  const project = { config: { labels: { groups: [{ id: "g", label: "G", classes: [{ name: "cat" }] }] } } } as never;
  const regions: Region[] = [
    { id: "1", type: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: "cat" },
    { id: "2", type: "polygon", points: [[0, 0], [1, 0], [1, 1]], label: "cat" },
    { id: "3", type: "keypoint", x: 0.5, y: 0.5, label: "cat" },
  ];
  for (const region of regions) {
    const annotation = toAnnotation(region);
    const primitive = regionPrimitives.find((candidate) => candidate.id === annotation.type)!;
    expect(primitive.normalize(annotation.value, project)).toEqual(annotation.value);
  }
});
