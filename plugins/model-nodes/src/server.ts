import type { Context } from "@neoworks/extension-system";
import type { NodeType } from "@atlas/contracts/server";
import { createClusterNode } from "./nodes/cluster";
import { createDedupeNode } from "./nodes/dedupe";
import { createEmbedNode } from "./nodes/embed";
import { createPredictNode } from "./nodes/predict";
import { createPropagateNode } from "./nodes/propagate";

/** Workflow nodes that work with whichever model provider a project is configured with. */
export function buildNodes(ctx: Context): NodeType[] {
  const services = { items: ctx.items, models: ctx.models, sources: ctx.sources };
  return [
    createEmbedNode(services),
    createPredictNode(services),
    createClusterNode(services),
    createPropagateNode(services),
    createDedupeNode(services),
  ];
}

export function apply(ctx: Context): void {
  ctx.inject(["workflows"], (innerCtx) => {
    for (const nodeType of buildNodes(innerCtx)) {
      innerCtx.effect(() => innerCtx.workflows.registerNode(nodeType), `node:${nodeType.type}`);
    }
  });
}

export default {
  name: "model-nodes",
  inject: ["items", "models", "sources"],
  apply,
};
