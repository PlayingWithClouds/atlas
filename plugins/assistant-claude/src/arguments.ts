import type { AssistantTurn } from "@atlas/plugin-assistant/types";
import { MCP_SERVER_NAME } from "./config";
import type { ResolvedClaudeConfig } from "./config";

export interface LaunchContext {
  /** Where this host's MCP endpoint listens. */
  mcpUrl: string;
  workspaceDirectory: string;
}

export function mcpConfigJson(mcpUrl: string): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: mcpUrl } } });
}

export function claudeSystemPrompt(turn: AssistantTurn, workspaceDirectory: string): string {
  const lines = [
    "You are the assistant inside Atlas, a general-purpose tool for labeling data such as images and video.",
    "",
    "The Atlas MCP tools read the data: sessions, items, the label classes, model insights and predictions.",
    "Use them first. For anything they do not cover, such as a custom query, a metric, or calling a model over a",
    "narrowed set, write a script and run it. Your working directory is the workspace's agent/ directory;",
    "installing what you need there is expected, and what you write stays for next time.",
    "",
    "You propose, a human decides. propose_labels writes proposals a human confirms in the labeling view;",
    "nothing you do labels, deletes or changes the label set on its own.",
    "",
    "Answer in a few sentences: what you found, and what you would do.",
  ];
  let prompt = lines.join("\n");
  if (turn.sessionId !== undefined) {
    prompt += `\n\nThe user is looking at session ${turn.sessionId}.`;
  }
  if (turn.projectId !== undefined) {
    prompt += ` The project is ${turn.projectId}.`;
  }
  prompt += `\nThe workspace is ${workspaceDirectory}; its exports/ holds labeled data written out for you.`;
  return prompt;
}

/**
 * Builds the command line. The MCP config is inline and strict, so the CLI sees Atlas's tools and
 * no others a developer happens to have configured. Permission checks are never bypassed: no
 * permission-skipping flag and no permission mode override is ever passed.
 */
export function buildClaudeArguments(config: ResolvedClaudeConfig, turn: AssistantTurn, launch: LaunchContext): string[] {
  const args = [
    config.binary,
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfigJson(launch.mcpUrl),
    "--strict-mcp-config",
    // Without this the assistant inherits the machine user's hooks, output styles and memory.
    "--setting-sources",
    "",
    "--tools",
    config.tools.join(","),
    "--allowedTools",
    config.allowedTools.join(","),
    "--add-dir",
    launch.workspaceDirectory,
    "--append-system-prompt",
    claudeSystemPrompt(turn, launch.workspaceDirectory),
  ];
  if (config.model !== undefined) {
    args.push("--model", config.model);
  }
  if (config.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(config.maxBudgetUsd));
  }
  if (turn.session !== undefined && turn.session !== "") {
    args.push("--resume", turn.session);
  }
  return args;
}
