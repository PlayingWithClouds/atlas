import type { Item, WorkItem } from "@atlas/contracts";
import type { Context } from "@neoworks/extension-system";
import type { NodeRunContext, NodeResult, NodeType } from "@atlas/contracts/server";
import { readBytes } from "./delivery";
import { loadSharp } from "./sharpLoader";

const GRID_SIZE = 16;

export interface QualityMetrics {
  luma: number;
  contrast: number;
}

export interface QualitySettings {
  check: string;
  black: number;
  flat: number;
  action: string;
}

/** Mean luma and its standard deviation over a 16x16 greyscale downsample (0-255 scale). */
export function metricsOfPixels(pixels: Uint8Array): QualityMetrics {
  let total = 0;
  for (const luma of pixels) {
    total += luma;
  }
  const mean = total / pixels.length;
  let squaredDistance = 0;
  for (const luma of pixels) {
    squaredDistance += (luma - mean) * (luma - mean);
  }
  return { luma: mean, contrast: Math.sqrt(squaredDistance / pixels.length) };
}

export async function measureBytes(bytes: Buffer): Promise<QualityMetrics | null> {
  const sharp = await loadSharp();
  if (sharp === null) {
    return null;
  }
  try {
    const pixels = await sharp(bytes)
      .rotate()
      .resize(GRID_SIZE, GRID_SIZE, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
    return metricsOfPixels(pixels);
  } catch (error) {
    return null;
  }
}

/** Metrics that could not be read pass: a broken file is not evidence of a bad picture. */
export function rejects(metrics: QualityMetrics | null, settings: QualitySettings): boolean {
  if (metrics === null) {
    return false;
  }
  const checksDark = settings.check === "dark" || settings.check === "both";
  const checksFlat = settings.check === "flat" || settings.check === "both";
  if (checksDark && metrics.luma < settings.black) {
    return true;
  }
  return checksFlat && metrics.contrast < settings.flat;
}

function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const raw = params[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return raw;
}

function stringParam(params: Record<string, unknown>, key: string, fallback: string): string {
  const raw = params[key];
  if (typeof raw !== "string" || raw === "") {
    return fallback;
  }
  return raw;
}

export function settingsOf(params: Record<string, unknown>): QualitySettings {
  return {
    check: stringParam(params, "check", "both"),
    black: numberParam(params, "black", 16),
    flat: numberParam(params, "flat", 8),
    action: stringParam(params, "action", "drop"),
  };
}

async function measureItem(ctx: Context, item: Item): Promise<QualityMetrics | null> {
  try {
    return await measureBytes(await readBytes(await ctx.sources.locate(item)));
  } catch (error) {
    return null;
  }
}

function applyAction(ctx: Context, item: Item, action: string): void {
  if (action === "skip") {
    ctx.items.setAnnotations(item.id, [], "skipped");
    return;
  }
  if (action === "delete") {
    ctx.items.remove(item.id);
  }
}

async function runQuality(ctx: Context, items: WorkItem[], context: NodeRunContext): Promise<NodeResult> {
  const settings = settingsOf(context.params);
  const itemsByRef = new Map(ctx.items.list(context.session.id).map((item) => [item.ref, item]));
  const kept: WorkItem[] = [];
  let rejectedCount = 0;
  for (const workItem of items) {
    context.job.progress(kept.length + rejectedCount, items.length);
    const item = itemsByRef.get(workItem.ref);
    if (item === undefined || !rejects(await measureItem(ctx, item), settings)) {
      kept.push(workItem);
      continue;
    }
    rejectedCount += 1;
    applyAction(ctx, item, settings.action);
  }
  context.job.progress(items.length, items.length);
  return { items: kept, message: `${rejectedCount} of ${items.length} rejected` };
}

export function qualityNode(ctx: Context): NodeType {
  return {
    type: "quality",
    plugin: "media-image",
    label: "Quality gate",
    description: "Rejects black or flat images judged on a 16x16 luma sample.",
    input: "items",
    output: "items",
    mediaKinds: ["image"],
    params: [
      {
        key: "check",
        kind: "option",
        label: "Check",
        default: "both",
        options: [
          { value: "dark", label: "Too dark" },
          { value: "flat", label: "Too flat" },
          { value: "both", label: "Both" },
        ],
      },
      { key: "black", kind: "number", label: "Black below (luma)", default: 16, min: 0, max: 255, step: 1 },
      { key: "flat", kind: "number", label: "Flat below (contrast)", default: 8, min: 0, max: 128, step: 1 },
      {
        key: "action",
        kind: "option",
        label: "Rejected items",
        default: "drop",
        options: [
          { value: "drop", label: "Drop from stream" },
          { value: "skip", label: "Mark skipped" },
          { value: "delete", label: "Delete" },
        ],
      },
    ],
    run: (items, context) => runQuality(ctx, items, context),
  };
}
