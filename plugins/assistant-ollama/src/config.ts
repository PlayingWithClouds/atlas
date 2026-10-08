export interface OllamaConfig {
  /** Base URL of the ollama server. */
  url?: string;
  /** Tool-calling chat model. Required: there is deliberately no default. */
  model?: string;
  /** Model that describes contact sheets for `look_at_session`; the tool is off without it. */
  visionModel?: string;
  /** Ceiling on model replies per turn, so a looping model ends in a visible answer. */
  maxToolCalls?: number;
}

export interface ResolvedOllamaConfig {
  url: string;
  model: string;
  visionModel: string | undefined;
  maxToolCalls: number;
}

export const DEFAULT_URL = "http://localhost:11434";
export const DEFAULT_MAX_TOOL_CALLS = 8;

function trimmedString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  const text = trimmedString(value);
  if (text === "") {
    return undefined;
  }
  return text;
}

function resolveMaxToolCalls(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_MAX_TOOL_CALLS;
}

export function resolveConfig(config: OllamaConfig): ResolvedOllamaConfig {
  const model = trimmedString(config.model);
  if (model === "") {
    throw new Error('assistant-ollama: config "model" is required');
  }
  let url = trimmedString(config.url);
  if (url === "") {
    url = DEFAULT_URL;
  }
  return {
    url: url.replace(/\/+$/, ""),
    model,
    visionModel: optionalString(config.visionModel),
    maxToolCalls: resolveMaxToolCalls(config.maxToolCalls),
  };
}
