import type { WorkItem } from "@atlas/contracts";
import type { NodeResult, NodeRunContext, NodeType } from "@atlas/contracts/server";
import { numberParam, thresholdParam } from "../params";
import { TAG_PRIMITIVE_MISSING_MESSAGE, projectUsesTags, providerFor, refsOf, tagAnnotation, tagLabelsOf } from "../support";
import type { ModelNodeServices } from "../support";

export const PROPAGATE_THRESHOLD = 0.92;

interface Proposal {
  labels: string[];
  sourceRef: string;
}

function isLabeledSource(item: WorkItem): boolean {
  return item.status === "labeled" && tagLabelsOf(item.annotations).length > 0;
}

function intersection(labelSets: string[][]): string[] {
  const [first, ...rest] = labelSets;
  return first.filter((label) => rest.every((labels) => labels.includes(label)));
}

/** Labels every labeled member agrees on; a disagreement shrinks them, never widens them. */
function proposalForGroup(members: string[], sources: Map<string, WorkItem>): Proposal | undefined {
  const sourceItems = members.map((ref) => sources.get(ref)).filter((item): item is WorkItem => item !== undefined);
  if (sourceItems.length === 0) {
    return undefined;
  }
  const labels = intersection(sourceItems.map((item) => tagLabelsOf(item.annotations)));
  if (labels.length === 0) {
    return undefined;
  }
  return { labels, sourceRef: sourceItems[0].ref };
}

function proposalsByTarget(
  groups: { members: string[] }[],
  sources: Map<string, WorkItem>,
  targets: Set<string>,
): Map<string, Proposal> {
  const proposals = new Map<string, Proposal>();
  for (const group of groups) {
    const proposal = proposalForGroup(group.members, sources);
    if (proposal === undefined) {
      continue;
    }
    for (const ref of group.members.filter((member) => targets.has(member))) {
      proposals.set(ref, proposal);
    }
  }
  return proposals;
}

function nothingToPropagateMessage(sourceCount: number): string {
  if (sourceCount === 0) {
    return "Propagate had nothing to copy from: no labeled items reached it";
  }
  return "Propagate had nothing to copy onto: every item that reached it is labeled";
}

/**
 * Propagation works on provider clusters at the given similarity: every unlabeled item that
 * shares a cluster with labeled items receives the tags all of those labeled items agree on.
 * Clusters are seeded greedily, so a member is within the threshold of its cluster's seed
 * rather than of every other member. Items outside such clusters pass through unchanged, so a
 * following save never clears proposals made earlier in the workflow.
 */
async function propagateItems(services: ModelNodeServices, items: WorkItem[], context: NodeRunContext): Promise<NodeResult> {
  if (!projectUsesTags(context.project)) {
    return { items, message: TAG_PRIMITIVE_MISSING_MESSAGE };
  }
  const sources = new Map(items.filter(isLabeledSource).map((item) => [item.ref, item]));
  const targets = new Set(items.filter((item) => item.status !== "labeled").map((item) => item.ref));
  if (sources.size === 0 || targets.size === 0) {
    return { items, message: nothingToPropagateMessage(sources.size) };
  }
  const threshold = numberParam(context.params, "threshold", PROPAGATE_THRESHOLD);
  const provider = providerFor(services, context.project);
  const groups = await provider.cluster(context.project.id, refsOf(items), threshold);
  const proposals = proposalsByTarget(groups, sources, targets);
  const propagated = items.map((item) => {
    const proposal = proposals.get(item.ref);
    if (proposal === undefined) {
      return item;
    }
    return { ...item, propagatedFrom: proposal.sourceRef, annotations: [tagAnnotation(proposal.labels)] };
  });
  return { items: propagated };
}

export function createPropagateNode(services: ModelNodeServices): NodeType {
  return {
    type: "propagate",
    plugin: "model-nodes",
    label: "Propagate labels",
    description: "Copy the tags of labeled items onto the unlabeled items that look like them",
    input: "items",
    output: "items",
    accepts: { embedded: true },
    emits: { annotation: "tag" },
    params: [thresholdParam("Similarity", PROPAGATE_THRESHOLD, 0.01)],
    run: (items, context) => propagateItems(services, items, context),
  };
}
