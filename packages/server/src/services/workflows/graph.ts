import type { GraphReport, NodeParam, NodeSpec, WorkflowEdge, WorkflowGraph, WorkflowNode } from "@atlas/contracts";

export type FindNodeSpec = (nodeType: string) => NodeSpec | undefined;

export function appliesToMediaKind(spec: NodeSpec, mediaKind: string): boolean {
  if (spec.mediaKinds === undefined || spec.mediaKinds.length === 0) {
    return true;
  }
  return spec.mediaKinds.includes(mediaKind);
}

/** Upstream node ids per node, in edge order so a node's inputs line up with its wires. */
export function incomingSourceIds(graph: WorkflowGraph): Map<string, string[]> {
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const sources = incoming.get(edge.target);
    if (sources === undefined) {
      incoming.set(edge.target, [edge.source]);
      continue;
    }
    sources.push(edge.source);
  }
  return incoming;
}

function indexNodes(graph: WorkflowGraph, findSpec: FindNodeSpec): Map<string, WorkflowNode> {
  const nodesById = new Map<string, WorkflowNode>();
  for (const node of graph.nodes) {
    if (findSpec(node.type) === undefined) {
      throw new Error(`unknown node type "${node.type}" (plugin unavailable?)`);
    }
    if (nodesById.has(node.id)) {
      throw new Error(`duplicate node id "${node.id}"`);
    }
    nodesById.set(node.id, node);
  }
  return nodesById;
}

function checkEdge(edge: WorkflowEdge, nodesById: Map<string, WorkflowNode>, findSpec: FindNodeSpec): void {
  const source = nodesById.get(edge.source);
  const target = nodesById.get(edge.target);
  if (source === undefined) {
    throw new Error(`edge references missing node "${edge.source}"`);
  }
  if (target === undefined) {
    throw new Error(`edge references missing node "${edge.target}"`);
  }
  if ((findSpec(source.type) as NodeSpec).output === "none") {
    throw new Error(`node ${source.id} (${source.type}) has no output to connect`);
  }
  if ((findSpec(target.type) as NodeSpec).input === "none") {
    throw new Error(`node ${target.id} (${target.type}) takes no input`);
  }
}

/** Kahn's algorithm; ties keep the order nodes appear in the graph. */
function topologicalOrder(graph: WorkflowGraph, nodesById: Map<string, WorkflowNode>): WorkflowNode[] {
  const remainingInputs = new Map<string, number>();
  const downstream = new Map<string, string[]>();
  for (const node of graph.nodes) {
    remainingInputs.set(node.id, 0);
    downstream.set(node.id, []);
  }
  for (const edge of graph.edges) {
    (downstream.get(edge.source) as string[]).push(edge.target);
    remainingInputs.set(edge.target, (remainingInputs.get(edge.target) as number) + 1);
  }
  const queue = graph.nodes.filter((node) => remainingInputs.get(node.id) === 0).map((node) => node.id);
  const ordered: WorkflowNode[] = [];
  for (let position = 0; position < queue.length; position += 1) {
    const nodeId = queue[position];
    ordered.push(nodesById.get(nodeId) as WorkflowNode);
    releaseDownstream(nodeId, downstream, remainingInputs, queue);
  }
  if (ordered.length !== graph.nodes.length) {
    throw new Error("workflow graph has a cycle");
  }
  return ordered;
}

function releaseDownstream(
  nodeId: string,
  downstream: Map<string, string[]>,
  remainingInputs: Map<string, number>,
  queue: string[],
): void {
  for (const nextId of downstream.get(nodeId) as string[]) {
    const remaining = (remainingInputs.get(nextId) as number) - 1;
    remainingInputs.set(nextId, remaining);
    if (remaining === 0) {
      queue.push(nextId);
    }
  }
}

/** Returns nodes in runnable order, or throws with the first structural problem. */
export function planGraph(graph: WorkflowGraph | undefined, findSpec: FindNodeSpec): WorkflowNode[] {
  if (graph === undefined || graph.nodes.length === 0) {
    throw new Error("empty workflow graph");
  }
  const nodesById = indexNodes(graph, findSpec);
  for (const edge of graph.edges) {
    checkEdge(edge, nodesById, findSpec);
  }
  return topologicalOrder(graph, nodesById);
}

// --- validation --------------------------------------------------------------------------

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function numberProblem(node: WorkflowNode, param: NodeParam, value: unknown): string | undefined {
  const number = toNumber(value);
  if (number === undefined) {
    return `node ${node.id}: param "${param.key}" wants a number, got ${String(value)}`;
  }
  if (param.min !== undefined && number < param.min) {
    return `node ${node.id}: param "${param.key}" is ${number}, below the minimum ${param.min}`;
  }
  if (param.max !== undefined && number > param.max) {
    return `node ${node.id}: param "${param.key}" is ${number}, above the maximum ${param.max}`;
  }
  return undefined;
}

function optionProblem(node: WorkflowNode, param: NodeParam, value: unknown): string | undefined {
  const allowed = (param.options || []).map((option) => option.value);
  if (allowed.includes(String(value))) {
    return undefined;
  }
  return `node ${node.id}: param "${param.key}" is "${String(value)}", not one of ${allowed.join(", ")}`;
}

function paramProblem(node: WorkflowNode, param: NodeParam, value: unknown): string | undefined {
  if (param.kind === "number") {
    return numberProblem(node, param, value);
  }
  if (param.kind === "option") {
    return optionProblem(node, param, value);
  }
  return undefined;
}

function paramErrors(node: WorkflowNode, spec: NodeSpec): string[] {
  const problems: string[] = [];
  const paramsByKey = new Map(spec.params.map((param) => [param.key, param]));
  const suppliedKeys = Object.keys(node.params || {}).sort();
  for (const key of suppliedKeys) {
    const param = paramsByKey.get(key);
    if (param === undefined) {
      problems.push(`node ${node.id} (${node.type}) has no param "${key}"`);
      continue;
    }
    const problem = paramProblem(node, param, (node.params as Record<string, unknown>)[key]);
    if (problem !== undefined) {
      problems.push(problem);
    }
  }
  return problems;
}

function isStandalone(node: WorkflowNode, findSpec: FindNodeSpec): boolean {
  const spec = findSpec(node.type);
  return spec !== undefined && spec.input === "none" && spec.output === "none";
}

function danglingNodeWarnings(graph: WorkflowGraph, findSpec: FindNodeSpec): string[] {
  if (graph.nodes.length === 1) {
    return [];
  }
  const wired = new Set<string>();
  for (const edge of graph.edges) {
    wired.add(edge.source);
    wired.add(edge.target);
  }
  return graph.nodes
    .filter((node) => !wired.has(node.id) && !isStandalone(node, findSpec))
    .map((node) => `node ${node.id} (${node.type}) is not connected to anything`);
}

function nodeWarnings(node: WorkflowNode, spec: NodeSpec, mediaKind: string | undefined): string[] {
  if (mediaKind === undefined || appliesToMediaKind(spec, mediaKind)) {
    return [];
  }
  return [`node ${node.id} (${node.type}) does not apply to ${mediaKind} projects`];
}

/** Checks a graph the way a run would, plus param and wiring problems a run would just carry out. */
export function validateGraph(graph: WorkflowGraph, findSpec: FindNodeSpec, mediaKind?: string): GraphReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    planGraph(graph, findSpec);
  } catch (error) {
    errors.push((error as Error).message);
  }
  for (const node of graph.nodes) {
    const spec = findSpec(node.type);
    if (spec === undefined) {
      continue;
    }
    errors.push(...paramErrors(node, spec));
    warnings.push(...nodeWarnings(node, spec, mediaKind));
  }
  warnings.push(...danglingNodeWarnings(graph, findSpec));
  return { ok: errors.length === 0, errors, warnings };
}
