import type { NodeType } from "@atlas/contracts/server";
import { optionParam, stringParam } from "../params";

/** Sets the reserved `action` field; the workflow executor applies and consumes it. */
export const actionNode: NodeType = {
  type: "action",
  plugin: "core-nodes",
  label: "Action",
  description: "Accept, reject, skip or delete the items flowing into this branch",
  input: "items",
  output: "none",
  params: [optionParam("action", "Do", ["accept", "reject", "skip", "delete"], "accept")],
  async run(items, context) {
    const action = stringParam(context.params, "action", "accept");
    return { items: items.map((item) => ({ ...item, action })) };
  },
};
