import type { WorkItem, WorkflowGraph } from "../../packages/contracts/src/index";
import type { NodeType } from "../../packages/contracts/src/server";
import WorkflowsCore from "../../packages/server/src/services/workflows";
import { createStubWorld } from "./stubs";
import type { StubWorld } from "./stubs";

export function makeNode(type: string, overrides: Partial<NodeType> = {}): NodeType {
  return {
    type,
    plugin: "test",
    label: type,
    description: "",
    input: "items",
    output: "items",
    params: [],
    async run(items) {
      return { items };
    },
    ...overrides,
  };
}

export function graphOf(nodes: [string, string][], edges: [string, string][]): WorkflowGraph {
  return {
    nodes: nodes.map(([id, type]) => ({ id, type, position: { x: 0, y: 0 } })),
    edges: edges.map(([source, target]) => ({ source, target })),
  };
}

export function refsOf(items: WorkItem[]): string[] {
  return items.map((item) => item.ref);
}

/** A source-like node: input none, emits every session item. */
export const sourceNode = makeNode("source", {
  input: "none",
  async run(_items, context) {
    return { items: context.sessionItems() };
  },
  dryRun: (_items, context) => context.sessionItems(),
});

export async function mountWorkflows(): Promise<StubWorld> {
  const world = createStubWorld();
  await world.context.plugin(WorkflowsCore as never);
  return world;
}
