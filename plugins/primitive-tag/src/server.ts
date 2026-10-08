import type { Context } from "@neoworks/extension-system";
import { classNamesOf } from "@atlas/contracts";
import type { Project } from "@atlas/contracts";
import type { Primitive } from "@atlas/contracts/server";

function labelsOf(value: Record<string, unknown>): string[] {
  if (!Array.isArray(value.labels)) {
    return [];
  }
  return value.labels.filter((label): label is string => typeof label === "string");
}

/** Keeps project classes only, drops duplicates and returns null when nothing is left. */
export function normalizeTag(value: Record<string, unknown>, project: Project): Record<string, unknown> | null {
  const knownClasses = new Set(classNamesOf(project.config));
  const kept = new Set<string>();
  for (const label of labelsOf(value)) {
    if (knownClasses.has(label)) {
      kept.add(label);
    }
  }
  if (kept.size === 0) {
    return null;
  }
  return { labels: [...kept] };
}

export const tagPrimitive: Primitive = {
  id: "tag",
  label: "Tags",
  normalize: normalizeTag,
  trainingLabels: labelsOf,
};

export default {
  name: "primitive-tag",
  inject: ["primitives"],
  apply(ctx: Context) {
    ctx.effect(() => ctx.primitives.register(tagPrimitive), "primitive:tag");
  },
};
