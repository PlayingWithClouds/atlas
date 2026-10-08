import type { AssistantMessage } from "@atlas/plugin-assistant/types";

/** A local model on a busy GPU is slow, not broken; a wedged ollama fails the turn instead. */
export const REPLY_TIMEOUT_MS = 5 * 60 * 1000;
const CAPABILITY_TIMEOUT_MS = 20 * 1000;

export type FunctionTool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

type RawReply = Omit<AssistantMessage, "tool_calls"> & {
  tool_calls?: { function: { name: string; arguments: unknown } }[];
};

/** Ollama may deliver tool arguments as an object or as a JSON string. */
function normalizeArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return normalizeArguments(JSON.parse(raw));
    } catch (error) {
      return {};
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

function normalizeReply(raw: RawReply): AssistantMessage {
  const { tool_calls: rawCalls, ...rest } = raw;
  if (rawCalls === undefined) {
    return rest;
  }
  const toolCalls = rawCalls.map((call) => ({
    function: { name: call.function.name, arguments: normalizeArguments(call.function.arguments) },
  }));
  return { ...rest, tool_calls: toolCalls };
}

export class OllamaClient {
  // What a model can do is a property of the build, not of the family, so it is asked.
  private readonly capabilityCache = new Map<string, string[]>();

  constructor(
    private readonly url: string,
    private readonly replyTimeoutMs = REPLY_TIMEOUT_MS,
  ) {}

  /** Whether the model returns its reasoning separately; `think` is rejected by models without it. */
  async thinks(model: string, signal: AbortSignal): Promise<boolean> {
    const capabilities = await this.capabilitiesOf(model, signal);
    return capabilities.includes("thinking");
  }

  /** Streaming is off: the loop needs the whole message to know whether a tool was requested. */
  async chat(model: string, messages: AssistantMessage[], tools: FunctionTool[], signal: AbortSignal): Promise<AssistantMessage> {
    const payload: Record<string, unknown> = { model, messages, stream: false };
    if (tools.length > 0) {
      payload.tools = tools;
    }
    if (await this.thinks(model, signal)) {
      payload.think = true;
    }
    const response = await this.post("/api/chat", payload, AbortSignal.any([signal, AbortSignal.timeout(this.replyTimeoutMs)]));
    if (!response.ok) {
      throw new Error(`ollama answered ${response.status} ${response.statusText}`.trim());
    }
    return this.readReply(response);
  }

  private async readReply(response: Response): Promise<AssistantMessage> {
    let decoded: { message?: RawReply; error?: string };
    try {
      decoded = (await response.json()) as { message?: RawReply; error?: string };
    } catch (error) {
      throw new Error("ollama returned an unreadable reply");
    }
    if (decoded.error) {
      throw new Error(`ollama: ${decoded.error}`);
    }
    if (decoded.message === undefined) {
      throw new Error("ollama returned an unreadable reply");
    }
    return normalizeReply(decoded.message);
  }

  private async post(path: string, payload: unknown, signal: AbortSignal): Promise<Response> {
    try {
      return await fetch(`${this.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new Error(`ollama unreachable at ${this.url}`);
    }
  }

  /** A failed probe caches nothing, so a model pulled later is picked up on the next turn. */
  private async capabilitiesOf(model: string, signal: AbortSignal): Promise<string[]> {
    const cached = this.capabilityCache.get(model);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const capabilities = await this.probeCapabilities(model, signal);
      this.capabilityCache.set(model, capabilities);
      return capabilities;
    } catch (error) {
      return [];
    }
  }

  private async probeCapabilities(model: string, signal: AbortSignal): Promise<string[]> {
    const response = await this.post("/api/show", { model }, AbortSignal.any([signal, AbortSignal.timeout(CAPABILITY_TIMEOUT_MS)]));
    if (!response.ok) {
      throw new Error(`ollama answered ${response.status}`);
    }
    const decoded = (await response.json()) as { capabilities?: unknown };
    if (!Array.isArray(decoded.capabilities)) {
      throw new Error("no capabilities in the reply");
    }
    return decoded.capabilities.filter((capability): capability is string => typeof capability === "string");
  }
}
