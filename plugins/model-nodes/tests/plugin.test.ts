import { expect, test } from "bun:test";
import type { Fiber } from "@neoworks/extension-system";
import WorkflowsCore from "../../../packages/server/src/services/workflows";
import { createStubWorld } from "../../../tests/server/stubs";
import modelNodes from "../src/server";

const EXPECTED_NODES = ["cluster", "dedupe", "embed", "predict", "propagate"];

async function mount() {
  const world = createStubWorld();
  (world.context as any).provide("sources", { locate: async () => ({ kind: "file", path: "/tmp/x" }) });
  await world.context.plugin(WorkflowsCore as never, undefined as never);
  const fiber = world.context.plugin(modelNodes as never, undefined as never) as Fiber;
  await fiber;
  return { world, fiber };
}

test("registers the generic model nodes without naming any encoder", async () => {
  const { world } = await mount();
  const specs = world.context.workflows.nodes();
  expect(specs.map((spec) => spec.type).sort()).toEqual(EXPECTED_NODES);
  for (const spec of specs) {
    expect(spec.plugin).toBe("model-nodes");
    expect(JSON.stringify(spec).toLowerCase()).not.toMatch(/siglip|joytag|dinov2/);
  }
});

test("disposing the plugin withdraws every node", async () => {
  const { world, fiber } = await mount();
  await fiber.dispose();
  expect(world.context.workflows.nodes()).toEqual([]);
});
