import type { Tool } from "@atlas/contracts/server";

/**
 * Tools that write, but only proposals or drafts a human still has to accept. They stay
 * exposed when `allowWrites` is off; every other tool must declare itself read-only.
 * Adding a name here is a deliberate decision: can this act without a human?
 */
export const PROPOSE_ALLOWLIST: ReadonlySet<string> = new Set(["propose_labels", "save_workflow"]);

export function isExposed(tool: Tool, allowWrites: boolean): boolean {
  if (allowWrites) {
    return true;
  }
  return tool.readOnly === true || PROPOSE_ALLOWLIST.has(tool.name);
}

export function exposedTools(tools: Tool[], allowWrites: boolean): Tool[] {
  return tools.filter((tool) => isExposed(tool, allowWrites)).sort((first, second) => first.name.localeCompare(second.name));
}
