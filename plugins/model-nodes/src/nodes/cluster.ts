import type { WorkItem } from "@atlas/contracts";
import type { NodeResult, NodeRunContext, NodeType } from "@atlas/contracts/server";
import { numberParam, thresholdParam } from "../params";
import { providerFor, refsOf } from "../support";
import type { ModelNodeServices } from "../support";

export const CLUSTER_THRESHOLD = 0.9;

interface Membership {
  clusterId: number;
  representative: boolean;
}

function membershipsOf(groups: { keep: string; members: string[] }[]): Map<string, Membership> {
  const memberships = new Map<string, Membership>();
  groups.forEach((group, clusterId) => {
    for (const ref of group.members) {
      memberships.set(ref, { clusterId, representative: ref === group.keep });
    }
  });
  return memberships;
}

async function clusterItems(services: ModelNodeServices, items: WorkItem[], context: NodeRunContext): Promise<NodeResult> {
  const threshold = numberParam(context.params, "threshold", CLUSTER_THRESHOLD);
  const provider = providerFor(services, context.project);
  const groups = await provider.cluster(context.project.id, refsOf(items), threshold);
  const memberships = membershipsOf(groups);
  // An item without a vector joins no group; marking it representative keeps a
  // "representatives only" filter from dropping it silently.
  const unclustered: Membership = { clusterId: -1, representative: true };
  const clustered = items.map((item) => {
    const membership = memberships.get(item.ref) || unclustered;
    return { ...item, cluster: membership.clusterId, representative: membership.representative };
  });
  return { items: clustered };
}

export function createClusterNode(services: ModelNodeServices): NodeType {
  return {
    type: "cluster",
    plugin: "model-nodes",
    label: "Cluster",
    description: "Group items that look alike and mark one representative per group",
    input: "items",
    output: "items",
    accepts: { embedded: true },
    emits: { cluster: "id" },
    params: [thresholdParam("Similarity", CLUSTER_THRESHOLD, 0.01)],
    run: (items, context) => clusterItems(services, items, context),
  };
}
