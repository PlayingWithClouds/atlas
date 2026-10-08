import type { Item, NodeSpec, Project, Session, WorkItem, WorkflowGraph, WorkflowNode } from "@atlas/contracts";
import { classNamesOf } from "@atlas/contracts";
import type {
  ItemsService,
  JobHandle,
  LabelingService,
  NodeRunContext,
  NodeType,
  NotificationsService,
} from "@atlas/contracts/server";
import { incomingSourceIds, planGraph } from "./graph";
import { mergeInputs, overlayProduced, skippedNodeMessage, splitByAccepts, toWorkItem } from "./stream";

export interface ExecutorEnvironment {
  items: ItemsService;
  labeling: LabelingService;
  notifications: NotificationsService;
  notifyLive(): void;
  findNode(nodeType: string): NodeType | undefined;
  /** Item ids whose label changes come from this executor and must not re-fire triggers. */
  actingItemIds: Set<string>;
}

export interface GraphRun {
  project: Project;
  session: Session;
  graph: WorkflowGraph;
  scopedItemId?: string;
  job: JobHandle;
}

function sessionWorkItems(environment: ExecutorEnvironment, sessionId: string): WorkItem[] {
  return environment.items.list(sessionId).map(toWorkItem);
}

function buildRunContext(
  environment: ExecutorEnvironment,
  run: GraphRun,
  node: WorkflowNode,
  inputs: WorkItem[][],
): NodeRunContext {
  return {
    project: run.project,
    session: run.session,
    classes: classNamesOf(run.project.config),
    params: node.params || {},
    job: run.job,
    inputs,
    sessionItems: () => sessionWorkItems(environment, run.session.id),
    scopedItemId: run.scopedItemId,
  };
}

function chunkItems(items: WorkItem[], batch: number | undefined): WorkItem[][] {
  if (batch === undefined || batch <= 0 || items.length === 0) {
    return [items];
  }
  const chunks: WorkItem[][] = [];
  for (let start = 0; start < items.length; start += batch) {
    chunks.push(items.slice(start, start + batch));
  }
  return chunks;
}

async function callInChunks(
  environment: ExecutorEnvironment,
  run: GraphRun,
  node: WorkflowNode,
  nodeType: NodeType,
  items: WorkItem[],
  inputs: WorkItem[][],
): Promise<{ produced: WorkItem[]; messages: Set<string> }> {
  const produced: WorkItem[] = [];
  const messages = new Set<string>();
  const context = buildRunContext(environment, run, node, inputs);
  let done = 0;
  for (const chunk of chunkItems(items, nodeType.batch)) {
    const result = await nodeType.run(chunk, context);
    produced.push(...result.items);
    if (result.message !== undefined && result.message !== "") {
      messages.add(result.message);
    }
    done += chunk.length;
    run.job.progress(done, items.length);
  }
  return { produced, messages };
}

async function applyAction(environment: ExecutorEnvironment, stored: Item, action: string): Promise<void> {
  if (action === "accept") {
    await environment.labeling.confirm(stored.id, stored.annotations);
    return;
  }
  if (action === "reject" || action === "skip") {
    environment.labeling.skip(stored.id);
    return;
  }
  if (action === "delete") {
    environment.items.remove(stored.id);
    return;
  }
  throw new Error(`unknown action "${action}"`);
}

async function applyActionTracked(environment: ExecutorEnvironment, stored: Item, action: string): Promise<void> {
  environment.actingItemIds.add(stored.id);
  try {
    await applyAction(environment, stored, action);
  } finally {
    environment.actingItemIds.delete(stored.id);
  }
}

/** Executes the reserved `action` field on items that carry it and consumes those items. */
async function applyItemActions(
  environment: ExecutorEnvironment,
  sessionId: string,
  items: WorkItem[],
): Promise<WorkItem[]> {
  const storedByRef = new Map(environment.items.list(sessionId).map((stored) => [stored.ref, stored]));
  const survivors: WorkItem[] = [];
  let acted = 0;
  for (const item of items) {
    if (typeof item.action !== "string" || item.action === "") {
      survivors.push(item);
      continue;
    }
    const stored = storedByRef.get(item.ref);
    if (stored === undefined) {
      continue;
    }
    await applyActionTracked(environment, stored, item.action);
    acted += 1;
  }
  if (acted > 0) {
    environment.notifyLive();
  }
  return survivors;
}

async function runNode(
  environment: ExecutorEnvironment,
  run: GraphRun,
  node: WorkflowNode,
  nodeType: NodeType,
  upstream: WorkItem[][],
): Promise<WorkItem[]> {
  run.job.phase(node.type);
  const stream = mergeInputs(upstream);
  if (nodeType.input === "none") {
    return runMatching(environment, run, node, nodeType, [], upstream, []);
  }
  const { matching, passthrough } = splitByAccepts(stream, nodeType.accepts);
  if (matching.length === 0) {
    const message = skippedNodeMessage(nodeType as NodeSpec, stream.length);
    environment.notifications.toast({ message, sessionId: run.session.id, level: "info" });
    return stream;
  }
  return runMatching(environment, run, node, nodeType, matching, upstream, passthrough);
}

async function runMatching(
  environment: ExecutorEnvironment,
  run: GraphRun,
  node: WorkflowNode,
  nodeType: NodeType,
  matching: WorkItem[],
  upstream: WorkItem[][],
  passthrough: WorkItem[],
): Promise<WorkItem[]> {
  run.job.progress(0, matching.length);
  const { produced, messages } = await callInChunks(environment, run, node, nodeType, matching, upstream);
  for (const message of [...messages].sort()) {
    environment.notifications.toast({ message, sessionId: run.session.id, level: "info" });
  }
  const merged = overlayProduced(matching, produced);
  const survivors = await applyItemActions(environment, run.session.id, merged);
  return [...survivors, ...passthrough];
}

/** Runs the graph's nodes in dependency order; each node's output feeds the nodes it connects to. */
export async function executeGraph(environment: ExecutorEnvironment, run: GraphRun): Promise<void> {
  const findSpec = (nodeType: string) => environment.findNode(nodeType);
  const ordered = planGraph(run.graph, findSpec);
  const incoming = incomingSourceIds(run.graph);
  const outputs = new Map<string, WorkItem[]>();
  for (const node of ordered) {
    const upstream = (incoming.get(node.id) || []).map((sourceId) => outputs.get(sourceId) || []);
    const nodeType = environment.findNode(node.type) as NodeType;
    try {
      outputs.set(node.id, await runNode(environment, run, node, nodeType, upstream));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`node ${node.id} (${node.type}): ${message}`);
    }
  }
}
