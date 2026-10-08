import type { WorkItem } from "@atlas/contracts";
import type { NodeResult, NodeRunContext, NodeType } from "@atlas/contracts/server";
import { numberParam, stringParam, thresholdParam } from "../params";
import { providerFor, refsOf } from "../support";
import type { ModelNodeServices } from "../support";

export const DEDUPE_THRESHOLD = 0.93;
const DEDUPE_ACTIONS = ["skip", "delete"];

function keptRefByDuplicate(groups: { keep: string; duplicates: string[] }[]): Map<string, string> {
  const keptRefs = new Map<string, string>();
  for (const group of groups) {
    for (const duplicate of group.duplicates) {
      keptRefs.set(duplicate, group.keep);
    }
  }
  return keptRefs;
}

function actionOf(context: NodeRunContext): string {
  const action = stringParam(context.params, "action", "skip");
  if (!DEDUPE_ACTIONS.includes(action)) {
    throw new Error(`dedupe action must be one of ${DEDUPE_ACTIONS.join(", ")}, got "${action}"`);
  }
  return action;
}

/** Marks every duplicate with the reserved `action` field; the executor applies it after the node. */
async function dedupeItems(services: ModelNodeServices, items: WorkItem[], context: NodeRunContext): Promise<NodeResult> {
  const action = actionOf(context);
  const threshold = numberParam(context.params, "threshold", DEDUPE_THRESHOLD);
  const provider = providerFor(services, context.project);
  const groups = await provider.duplicates(context.project.id, refsOf(items), threshold);
  const keptRefs = keptRefByDuplicate(groups);
  const marked = items.map((item) => {
    const keptRef = keptRefs.get(item.ref);
    if (keptRef === undefined) {
      return item;
    }
    return { ...item, action, keep: keptRef };
  });
  return { items: marked };
}

export function createDedupeNode(services: ModelNodeServices): NodeType {
  return {
    type: "dedupe",
    plugin: "model-nodes",
    label: "Deduplicate",
    description: "Skip or delete near-duplicates, keeping one item per group of look-alikes",
    input: "items",
    output: "items",
    accepts: { embedded: true },
    params: [
      thresholdParam("Similarity", DEDUPE_THRESHOLD, 0.01),
      {
        key: "action",
        kind: "option",
        label: "On duplicate",
        default: "skip",
        options: DEDUPE_ACTIONS.map((value) => ({ value, label: value })),
      },
    ],
    run: (items, context) => dedupeItems(services, items, context),
  };
}
