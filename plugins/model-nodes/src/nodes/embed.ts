import { describeItems } from "@atlas/server";
import type { WorkItem } from "@atlas/contracts";
import type { NodeResult, NodeRunContext, NodeType } from "@atlas/contracts/server";
import { providerFor, storedItemsOf } from "../support";
import type { ModelNodeServices } from "../support";

export const EMBED_BATCH = 16;

async function embedItems(services: ModelNodeServices, items: WorkItem[], context: NodeRunContext): Promise<NodeResult> {
  const stored = storedItemsOf(services, items);
  const provider = providerFor(services, context.project);
  const descriptors = await describeItems(services.sources, stored);
  const { embedded } = await provider.embed(context.project.id, descriptors);
  const embeddedRefs = new Set(embedded);
  const embeddedIds = stored.filter((item) => embeddedRefs.has(item.ref)).map((item) => item.id);
  services.items.setEmbedded(embeddedIds, true);
  const result: NodeResult = { items: items.filter((item) => embeddedRefs.has(item.ref)).map((item) => ({ ...item, embedded: true })) };
  const failed = items.length - result.items.length;
  if (failed > 0) {
    result.message = `Embed could not read ${failed} item${failed === 1 ? "" : "s"}; they stay unembedded`;
  }
  return result;
}

export function createEmbedNode(services: ModelNodeServices): NodeType {
  return {
    type: "embed",
    plugin: "model-nodes",
    label: "Embed",
    description: "Compute embeddings with the project's model so items can be predicted, clustered and compared",
    input: "items",
    output: "items",
    accepts: { embedded: false },
    emits: { embedded: true },
    batch: EMBED_BATCH,
    params: [],
    run: (items, context) => embedItems(services, items, context),
    dryRun: (items) => items.map((item) => ({ ...item, embedded: true })),
  };
}
