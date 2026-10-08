import type { Item, NodeSpec, WorkItem } from "@atlas/contracts";

/** Snapshot of a stored item as it flows through a graph. `itemId` lets nodes find the row again. */
export function toWorkItem(item: Item): WorkItem {
  const workItem: WorkItem = {
    ref: item.ref,
    itemId: item.id,
    mediaKind: item.mediaKind,
    status: item.status,
    embedded: item.embedded,
    annotations: item.annotations,
  };
  if (item.span !== undefined) {
    workItem.span = item.span;
  }
  return workItem;
}

/** Flattens upstream outputs in edge order, dropping repeated refs (first wins). */
export function mergeInputs(outputs: WorkItem[][]): WorkItem[] {
  const seenRefs = new Set<string>();
  const merged: WorkItem[] = [];
  for (const output of outputs) {
    for (const item of output) {
      if (item.ref !== "" && seenRefs.has(item.ref)) {
        continue;
      }
      seenRefs.add(item.ref);
      merged.push(item);
    }
  }
  return merged;
}

function hasAnnotationType(item: WorkItem, annotationType: string): boolean {
  if (!Array.isArray(item.annotations)) {
    return false;
  }
  return item.annotations.some((annotation) => annotation.type === annotationType);
}

/** Field equality per key; the special key `annotation` means "has an annotation of that type". */
export function matchesAccepts(item: WorkItem, accepts: Record<string, unknown>): boolean {
  for (const [key, wanted] of Object.entries(accepts)) {
    if (key === "annotation") {
      if (!hasAnnotationType(item, String(wanted))) {
        return false;
      }
      continue;
    }
    if (String(item[key]) !== String(wanted)) {
      return false;
    }
  }
  return true;
}

export interface AcceptsSplit {
  matching: WorkItem[];
  passthrough: WorkItem[];
}

export function splitByAccepts(items: WorkItem[], accepts: Record<string, unknown> | undefined): AcceptsSplit {
  if (accepts === undefined || Object.keys(accepts).length === 0) {
    return { matching: items, passthrough: [] };
  }
  const split: AcceptsSplit = { matching: [], passthrough: [] };
  for (const item of items) {
    if (matchesAccepts(item, accepts)) {
      split.matching.push(item);
    } else {
      split.passthrough.push(item);
    }
  }
  return split;
}

/**
 * Overlays each produced item onto the input item with the same ref, so sparse results keep their
 * upstream fields. Produced items with no matching input pass through as-is (generator nodes).
 */
export function overlayProduced(inputs: WorkItem[], produced: WorkItem[]): WorkItem[] {
  const inputsByRef = new Map<string, WorkItem>();
  for (const input of inputs) {
    if (input.ref !== "") {
      inputsByRef.set(input.ref, input);
    }
  }
  return produced.map((item) => {
    const base = inputsByRef.get(item.ref);
    if (base === undefined) {
      return item;
    }
    return { ...base, ...item };
  });
}

function describeCondition(key: string, wanted: unknown): string {
  if (key === "embedded") {
    if (wanted === true) {
      return "embedded";
    }
    return "unembedded";
  }
  if (key === "annotation") {
    return `annotated with ${String(wanted)}`;
  }
  if (key === "status") {
    return String(wanted);
  }
  return `${key}=${String(wanted)}`;
}

function describeAccepts(accepts: Record<string, unknown> | undefined): string {
  if (accepts === undefined || Object.keys(accepts).length === 0) {
    return "";
  }
  const parts = Object.keys(accepts)
    .sort()
    .map((key) => describeCondition(key, accepts[key]));
  return `are ${parts.join(" and ")}`;
}

/** Names the unmet condition: "Embed skipped - none of the 328 items are unembedded". */
export function skippedNodeMessage(spec: NodeSpec, total: number): string {
  let label = spec.label;
  if (label === "") {
    label = spec.type;
  }
  const requirement = describeAccepts(spec.accepts);
  if (requirement === "") {
    return `${label} skipped - no items matched`;
  }
  return `${label} skipped - none of the ${total} items ${requirement}`;
}
