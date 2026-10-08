import type { Annotation } from "@atlas/contracts";

/** Regions live in normalized image coordinates: 0..1 on both axes, independent of pixel size. */
export type Point = [number, number];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Region =
  | ({ id: string; type: "rect"; label: string } & Box)
  | { id: string; type: "polygon"; label: string; points: Point[] }
  | { id: string; type: "keypoint"; label: string; x: number; y: number };

export type RegionType = Region["type"];

/** Geometry of a region that was just drawn, before it gets an id and a class. */
export type RegionDraft =
  | ({ type: "rect" } & Box)
  | { type: "polygon"; points: Point[] }
  | { type: "keypoint"; x: number; y: number };

export function regionFromDraft(draft: RegionDraft, id: string): Region {
  return { ...draft, id, label: "" } as Region;
}

export const REGION_TYPES: RegionType[] = ["rect", "polygon", "keypoint"];
export const MINIMUM_BOX_SIZE = 0.005;
export const KEYPOINT_HIT_RADIUS = 0.02;

export function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function clampPoint(point: Point): Point {
  return [clampUnit(point[0]), clampUnit(point[1])];
}

/** Turns a drag (possibly right-to-left or bottom-to-top) into a positive box inside the image. */
export function normalizeDraftBox(startPoint: Point, endPoint: Point): Box {
  const [startX, startY] = clampPoint(startPoint);
  const [endX, endY] = clampPoint(endPoint);
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    w: Math.abs(endX - startX),
    h: Math.abs(endY - startY),
  };
}

export function isLargeEnough(box: Box): boolean {
  return box.w >= MINIMUM_BOX_SIZE && box.h >= MINIMUM_BOX_SIZE;
}

/** Converts a pixel position inside an image of the given size to normalized coordinates. */
export function toNormalizedPoint(pixelX: number, pixelY: number, width: number, height: number): Point {
  return clampPoint([pixelX / width, pixelY / height]);
}

export function toAnnotation(region: Region): Annotation {
  if (region.type === "rect") {
    return { type: "rect", value: { x: region.x, y: region.y, w: region.w, h: region.h, label: region.label } };
  }
  if (region.type === "polygon") {
    return { type: "polygon", value: { points: region.points, label: region.label } };
  }
  return { type: "keypoint", value: { x: region.x, y: region.y, label: region.label } };
}

function labelOf(value: Record<string, unknown>): string {
  if (typeof value.label === "string") {
    return value.label;
  }
  return "";
}

function numberOf(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

function pointsOf(value: unknown): Point[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((raw) => clampPoint([numberOf(raw[0]), numberOf(raw[1])]));
}

/** Returns undefined for annotation types this workspace does not edit (e.g. tags). */
export function fromAnnotation(annotation: Annotation, id: string): Region | undefined {
  const value = annotation.value;
  const label = labelOf(value);
  if (annotation.type === "rect") {
    return { id, type: "rect", label, x: numberOf(value.x), y: numberOf(value.y), w: numberOf(value.w), h: numberOf(value.h) };
  }
  if (annotation.type === "polygon") {
    return { id, type: "polygon", label, points: pointsOf(value.points) };
  }
  if (annotation.type === "keypoint") {
    return { id, type: "keypoint", label, x: numberOf(value.x), y: numberOf(value.y) };
  }
  return undefined;
}

export function isRegionAnnotation(annotation: Annotation): boolean {
  return REGION_TYPES.includes(annotation.type as RegionType);
}

export function boundsOf(region: Region): Box {
  if (region.type === "polygon") {
    const xs = region.points.map((point) => point[0]);
    const ys = region.points.map((point) => point[1]);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return { x: left, y: top, w: Math.max(...xs) - left, h: Math.max(...ys) - top };
  }
  if (region.type === "rect") {
    return { x: region.x, y: region.y, w: region.w, h: region.h };
  }
  return { x: region.x, y: region.y, w: 0, h: 0 };
}

/** Limits a drag so the region's bounding box stays inside the image. */
function clampShift(region: Region, shiftX: number, shiftY: number): Point {
  const bounds = boundsOf(region);
  const limitedX = Math.min(1 - bounds.x - bounds.w, Math.max(-bounds.x, shiftX));
  const limitedY = Math.min(1 - bounds.y - bounds.h, Math.max(-bounds.y, shiftY));
  return [limitedX, limitedY];
}

export function moveRegion(region: Region, shiftX: number, shiftY: number): Region {
  const [dx, dy] = clampShift(region, shiftX, shiftY);
  if (region.type === "polygon") {
    return { ...region, points: region.points.map(([x, y]): Point => [x + dx, y + dy]) };
  }
  return { ...region, x: region.x + dx, y: region.y + dy };
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [currentX, currentY] = polygon[index];
    const [previousX, previousY] = polygon[previous];
    const crossesRay = currentY > point[1] !== previousY > point[1];
    if (crossesRay && point[0] < ((previousX - currentX) * (point[1] - currentY)) / (previousY - currentY) + currentX) {
      inside = !inside;
    }
  }
  return inside;
}

function containsPoint(region: Region, point: Point): boolean {
  if (region.type === "rect") {
    return point[0] >= region.x && point[0] <= region.x + region.w && point[1] >= region.y && point[1] <= region.y + region.h;
  }
  if (region.type === "keypoint") {
    return Math.hypot(point[0] - region.x, point[1] - region.y) < KEYPOINT_HIT_RADIUS;
  }
  return pointInPolygon(point, region.points);
}

/** Topmost (last drawn) region under the point. */
export function hitTest(regions: Region[], point: Point): Region | undefined {
  for (let index = regions.length - 1; index >= 0; index -= 1) {
    if (containsPoint(regions[index], point)) {
      return regions[index];
    }
  }
  return undefined;
}

export interface View {
  scale: number;
  translateX: number;
  translateY: number;
}

export const INITIAL_VIEW: View = { scale: 1, translateX: 0, translateY: 0 };
export const MINIMUM_SCALE = 1;
export const MAXIMUM_SCALE = 8;

/** Zooms so the point under the cursor (in the translated, unscaled space) stays put. */
export function zoomAround(view: View, pointX: number, pointY: number, factor: number): View {
  const scale = Math.min(MAXIMUM_SCALE, Math.max(MINIMUM_SCALE, view.scale * factor));
  const ratio = scale / view.scale;
  return {
    scale,
    translateX: pointX - (pointX - view.translateX) * ratio,
    translateY: pointY - (pointY - view.translateY) * ratio,
  };
}

/** Regions need a class before the server keeps them; returns the ones still missing one. */
export function unlabeledRegions(regions: Region[]): Region[] {
  return regions.filter((region) => region.label === "");
}

/** Stable hue per class name so the same class always draws in the same color. */
export function hueOf(label: string): number {
  let hue = 0;
  for (const character of label) {
    hue = (hue * 31 + character.charCodeAt(0)) % 360;
  }
  return hue;
}
