import type { Tool } from "@atlas/contracts/server";

/**
 * Tools that write only proposals or drafts a human still has to accept. Every other tool must
 * be read-only to reach the model: a tool that is not offered cannot be talked into firing.
 */
export const PROPOSE_ALLOWLIST: ReadonlySet<string> = new Set(["propose_labels", "save_workflow"]);

export function isOffered(tool: Tool): boolean {
  return tool.readOnly === true || PROPOSE_ALLOWLIST.has(tool.name);
}
