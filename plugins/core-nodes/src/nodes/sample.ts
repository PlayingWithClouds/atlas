import type { WorkItem } from "@atlas/contracts";
import type { NodeRunContext, NodeType } from "@atlas/contracts/server";
import { numberParam, optionParam, stringParam } from "../params";

export function takeFirst(items: WorkItem[], count: number): WorkItem[] {
  if (count <= 0 || count >= items.length) {
    return items;
  }
  return items.slice(0, count);
}

export function shuffled(items: WorkItem[], random: () => number = Math.random): WorkItem[] {
  const copy = [...items];
  for (let position = copy.length - 1; position > 0; position -= 1) {
    const swapWith = Math.floor(random() * (position + 1));
    [copy[position], copy[swapWith]] = [copy[swapWith], copy[position]];
  }
  return copy;
}

/** Places ranked refs first; anything the ranker did not mention keeps its order at the end. */
function arrangeByRank(items: WorkItem[], rankedRefs: string[]): WorkItem[] {
  const itemsByRef = new Map(items.map((item) => [item.ref, item]));
  const placed = new Set<string>();
  const arranged: WorkItem[] = [];
  for (const ref of rankedRefs) {
    const item = itemsByRef.get(ref);
    if (item !== undefined && !placed.has(ref)) {
      arranged.push(item);
      placed.add(ref);
    }
  }
  return [...arranged, ...items.filter((item) => !placed.has(item.ref))];
}

type Ranker = (refs: string[], context: NodeRunContext) => Promise<string[]>;

async function orderItems(items: WorkItem[], order: string, context: NodeRunContext, rank: Ranker): Promise<WorkItem[]> {
  if (order === "random") {
    return shuffled(items);
  }
  if (order !== "uncertain" || items.length < 2) {
    return items;
  }
  try {
    return arrangeByRank(items, await rank(items.map((item) => item.ref), context));
  } catch (error) {
    // No loaded model or untrained head: stay in natural order rather than failing the run.
    return items;
  }
}

export function createSampleNode(rank: Ranker): NodeType {
  return {
    type: "sample",
    plugin: "core-nodes",
    label: "Sample",
    description: "Reorder the items and optionally keep only the first N",
    input: "items",
    output: "items",
    params: [
      optionParam("order", "Order", ["natural", "random", "uncertain"], "natural"),
      { key: "count", kind: "number", label: "Count (0 keeps all)", default: 0, min: 0, step: 1 },
    ],
    async run(items, context) {
      const order = stringParam(context.params, "order", "natural");
      const ordered = await orderItems(items, order, context, rank);
      return { items: takeFirst(ordered, numberParam(context.params, "count", 0)) };
    },
    dryRun(items, context) {
      return takeFirst(items, numberParam(context.params, "count", 0));
    },
  };
}
