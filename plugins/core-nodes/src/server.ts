import type { Context } from "@neoworks/extension-system";
import type { NodeRunContext, NodeType } from "@atlas/contracts/server";
import { actionNode } from "./nodes/action";
import { filterNode } from "./nodes/filter";
import { createNotifyNode } from "./nodes/notify";
import { createSampleNode } from "./nodes/sample";
import { createSaveNode } from "./nodes/save";
import { sessionItemsNode } from "./nodes/sessionItems";
import { STANDARD_TRIGGERS } from "./triggers";
import { assistantTools } from "./tools";

function buildNodes(ctx: Context): NodeType[] {
  const rank = async (refs: string[], context: NodeRunContext) => {
    const provider = ctx.models.forProject(context.project);
    const ranked = await provider.rank(context.project.id, refs, context.classes);
    return ranked.order;
  };
  return [
    sessionItemsNode,
    filterNode,
    createSampleNode(rank),
    createSaveNode({ items: ctx.items, labeling: ctx.labeling }),
    actionNode,
    createNotifyNode(ctx.notifications),
  ];
}

function registerNodesAndTriggers(ctx: Context): void {
  for (const nodeType of buildNodes(ctx)) {
    ctx.effect(() => ctx.workflows.registerNode(nodeType), `node:${nodeType.type}`);
  }
  for (const trigger of STANDARD_TRIGGERS) {
    ctx.effect(() => ctx.workflows.registerTrigger(trigger), `trigger:${trigger.id}`);
  }
}

function registerTools(ctx: Context): void {
  const tools = assistantTools({
    items: ctx.items,
    projects: ctx.projects,
    models: ctx.models,
    primitives: ctx.primitives,
    workflows: ctx.workflows,
  });
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `tool:${tool.name}`);
  }
}

function subscribeToEvents(ctx: Context): void {
  ctx.on("session/created", (session) => {
    ctx.workflows.fire({ trigger: "session_created", sessionId: session.id });
  });
  ctx.on("session/opened", (session) => {
    ctx.workflows.fire({ trigger: "session_opened", sessionId: session.id });
  });
  ctx.on("session/closed", (session) => {
    ctx.workflows.fire({ trigger: "session_closed", sessionId: session.id });
  });
  ctx.on("items/labeled", (item) => {
    ctx.workflows.fire({ trigger: "item_accepted", sessionId: item.sessionId, itemId: item.id });
  });
  ctx.on("item/opened", (item) => {
    ctx.workflows.fire({ trigger: "item_opened", sessionId: item.sessionId, itemId: item.id });
  });
  ctx.on("item/rejected", (item) => {
    ctx.workflows.fire({ trigger: "item_rejected", sessionId: item.sessionId, itemId: item.id });
  });
}

export function apply(ctx: Context): void {
  registerNodesAndTriggers(ctx);
  registerTools(ctx);
  subscribeToEvents(ctx);
}

export default {
  name: "core-nodes",
  inject: ["workflows", "tools", "items", "projects", "labeling", "models", "primitives", "notifications"],
  apply,
};
