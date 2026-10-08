import type { NodeType } from "@atlas/contracts/server";

export const sessionItemsNode: NodeType = {
  type: "session-items",
  plugin: "core-nodes",
  label: "Session items",
  description: "Start from the items in the session, or just the item that fired the trigger",
  input: "none",
  output: "items",
  params: [],
  async run(_items, context) {
    const sessionItems = context.sessionItems();
    if (context.scopedItemId === undefined) {
      return { items: sessionItems };
    }
    return { items: sessionItems.filter((item) => item.itemId === context.scopedItemId) };
  },
  dryRun(_items, context) {
    return context.sessionItems();
  },
};
