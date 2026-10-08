export interface ClaudeConfig {
  /** The Claude Code CLI executable. */
  binary?: string;
  model?: string;
  maxBudgetUsd?: number;
  /** Seconds before a turn is killed. */
  timeoutSeconds?: number;
  /** Built-in tools the CLI may use at all. */
  tools?: string[];
  /** Tools that run without a permission prompt. Permissions are never skipped wholesale. */
  allowedTools?: string[];
}

export interface ResolvedClaudeConfig {
  binary: string;
  model: string | undefined;
  maxBudgetUsd: number | undefined;
  timeoutSeconds: number;
  tools: string[];
  allowedTools: string[];
}

/** The prefix MCP tools appear under: mcp__atlas__list_sessions. */
export const MCP_SERVER_NAME = "atlas";

export const DEFAULT_BINARY = "claude";
export const DEFAULT_TIMEOUT_SECONDS = 900;
export const DEFAULT_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"];
export const DEFAULT_ALLOWED_TOOLS = [`mcp__${MCP_SERVER_NAME}__*`, "Read", "Glob", "Grep", "Write", "Edit", "Bash"];

function nonEmptyList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value) && value.length > 0) {
    return value.map((entry) => String(entry));
  }
  return fallback;
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return undefined;
}

function stringOr(value: unknown, fallback: string): string {
  const text = nonEmptyString(value);
  if (text === undefined) {
    return fallback;
  }
  return text;
}

function numberOr(value: unknown, fallback: number): number {
  const number = positiveNumber(value);
  if (number === undefined) {
    return fallback;
  }
  return number;
}

export function resolveConfig(config: ClaudeConfig): ResolvedClaudeConfig {
  return {
    binary: stringOr(config.binary, DEFAULT_BINARY),
    model: nonEmptyString(config.model),
    maxBudgetUsd: positiveNumber(config.maxBudgetUsd),
    timeoutSeconds: numberOr(config.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
    tools: nonEmptyList(config.tools, DEFAULT_TOOLS),
    allowedTools: nonEmptyList(config.allowedTools, DEFAULT_ALLOWED_TOOLS),
  };
}
