import type { NodeSpec, Project, Session, WorkItem, WorkflowGraph, WorkflowNode } from "@atlas/contracts";
import { classNamesOf } from "@atlas/contracts";
import type { DryRunReport, NodeDryRunContext, NodeType } from "@atlas/contracts/server";
import { incomingSourceIds, planGraph, validateGraph } from "./graph";
import { mergeInputs, skippedNodeMessage, splitByAccepts } from "./stream";

export interface DryRunInput {
  project: Project;
  session: Session;
  graph: WorkflowGraph;
  entities: WorkItem[];
  findNode(nodeType: string): NodeType | undefined;
  sessionItems(): WorkItem[];
}

type NodeEstimate = DryRunReport["nodes"][number];

function simulateMatching(nodeType: NodeType, matching: WorkItem[], context: NodeDryRunContext): WorkItem[] {
  if (nodeType.dryRun === undefined) {
    return matching;
  }
  return nodeType.dryRun(matching, context);
}

function estimateNode(
  node: WorkflowNode,
  nodeType: NodeType,
  streamItems: WorkItem[],
  context: NodeDryRunContext,
): { estimate: NodeEstimate; output: WorkItem[] } {
  const { matching, passthrough } = splitByAccepts(streamItems, nodeType.accepts);
  const estimate: NodeEstimate = {
    id: node.id,
    type: node.type,
    in: streamItems.length,
    matched: matching.length,
    passthrough: passthrough.length,
    out: 0,
  };
  const simulated = simulateMatching(nodeType, matching, context);
  const hasAccepts = nodeType.accepts !== undefined && Object.keys(nodeType.accepts).length > 0;
  if (matching.length === 0 && nodeType.input !== "none" && hasAccepts) {
    estimate.note = skippedNodeMessage(nodeType as NodeSpec, streamItems.length);
  } else if (simulated.length === 0 && matching.length > 0 && nodeType.dryRun !== undefined) {
    estimate.note = "this node empties the stream";
  }
  const output = [...simulated, ...passthrough];
  estimate.out = output.length;
  return { estimate, output };
}

/**
 * Walks the graph over a snapshot of the session and counts what would reach each node. Only
 * nodes that declare a `dryRun` hook are simulated; no node's `run` is ever called.
 */
export function dryRunGraph(input: DryRunInput): DryRunReport {
  const findSpec = (nodeType: string) => input.findNode(nodeType);
  const report = validateGraph(input.graph, findSpec, input.project.config.mediaKind);
  const result: DryRunReport = { report, entities: 0, nodes: [] };
  let ordered: WorkflowNode[];
  try {
    ordered = planGraph(input.graph, findSpec);
  } catch (error) {
    return result;
  }
  result.entities = input.entities.length;
  const incoming = incomingSourceIds(input.graph);
  const outputs = new Map<string, WorkItem[]>();
  for (const node of ordered) {
    const nodeType = input.findNode(node.type) as NodeType;
    const upstream = (incoming.get(node.id) || []).map((sourceId) => outputs.get(sourceId) || []);
    const streamItems = chooseStream(nodeType, upstream, input.entities);
    const context = describeContext(input, node);
    const { estimate, output } = estimateNode(node, nodeType, streamItems, context);
    outputs.set(node.id, output);
    result.nodes.push(estimate);
  }
  return result;
}

function chooseStream(nodeType: NodeType, upstream: WorkItem[][], entities: WorkItem[]): WorkItem[] {
  if (nodeType.input === "none") {
    return entities;
  }
  return mergeInputs(upstream);
}

function describeContext(input: DryRunInput, node: WorkflowNode): NodeDryRunContext {
  return {
    project: input.project,
    session: input.session,
    classes: classNamesOf(input.project.config),
    params: node.params || {},
    sessionItems: input.sessionItems,
  };
}
