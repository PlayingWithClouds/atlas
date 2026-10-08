import type { Context } from "@neoworks/extension-system";
import { classNamesOf } from "@atlas/contracts";
import type { Project } from "@atlas/contracts";
import type { Primitive } from "@atlas/contracts/server";

type Value = Record<string, unknown>;

function clampUnit(number: number): number {
  return Math.min(1, Math.max(0, number));
}

function unitCoordinate(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return clampUnit(raw);
}

function projectLabel(raw: unknown, project: Project): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  if (!classNamesOf(project.config).includes(raw)) {
    return null;
  }
  return raw;
}

function unitCoordinates(value: Value, keys: string[]): Record<string, number> | null {
  const coordinates: Record<string, number> = {};
  for (const key of keys) {
    const coordinate = unitCoordinate(value[key]);
    if (coordinate === null) {
      return null;
    }
    coordinates[key] = coordinate;
  }
  return coordinates;
}

function normalizeRect(value: Value, project: Project): Value | null {
  const label = projectLabel(value.label, project);
  const box = unitCoordinates(value, ["x", "y", "w", "h"]);
  if (label === null || box === null) {
    return null;
  }
  // A box may not extend past the image edge.
  const width = Math.min(box.w, 1 - box.x);
  const height = Math.min(box.h, 1 - box.y);
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { x: box.x, y: box.y, w: width, h: height, label };
}

function normalizePoint(raw: unknown): [number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 2) {
    return null;
  }
  const x = unitCoordinate(raw[0]);
  const y = unitCoordinate(raw[1]);
  if (x === null || y === null) {
    return null;
  }
  return [x, y];
}

function normalizePolygon(value: Value, project: Project): Value | null {
  const label = projectLabel(value.label, project);
  if (label === null || !Array.isArray(value.points) || value.points.length < 3) {
    return null;
  }
  const points: [number, number][] = [];
  for (const raw of value.points) {
    const point = normalizePoint(raw);
    if (point === null) {
      return null;
    }
    points.push(point);
  }
  return { points, label };
}

function normalizeKeypoint(value: Value, project: Project): Value | null {
  const label = projectLabel(value.label, project);
  const point = unitCoordinates(value, ["x", "y"]);
  if (label === null || point === null) {
    return null;
  }
  return { x: point.x, y: point.y, label };
}

export const regionPrimitives: Primitive[] = [
  { id: "rect", label: "Bounding box", normalize: normalizeRect },
  { id: "polygon", label: "Polygon", normalize: normalizePolygon },
  { id: "keypoint", label: "Keypoint", normalize: normalizeKeypoint },
];

export default {
  name: "primitive-region",
  inject: ["primitives"],
  apply(ctx: Context) {
    for (const primitive of regionPrimitives) {
      ctx.effect(() => ctx.primitives.register(primitive), `primitive:${primitive.id}`);
    }
  },
};
