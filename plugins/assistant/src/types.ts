// Loads the kernel module before augmenting it; without this tsc drops the kernel's own Context members.
import type {} from "@neoworks/extension-system";

/**
 * The assistant-backend contract. It lives in this plugin, not in core contracts: backends
 * are plugins of the assistant plugin and inject `assistantBackends` like any other service.
 */

export type Dispose = () => void;

/** One message of the conversation, in the shape local chat backends replay as history. */
export interface AssistantMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  images?: string[];
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

export type AssistantEventKind = "tool" | "tool_result" | "thinking" | "message" | "error" | "session" | "done";

/** One thing worth telling the page about while a turn runs. */
export interface AssistantEvent {
  kind: AssistantEventKind;
  tool?: string;
  detail?: string;
  content?: string;
  /** The backend's own conversation id, sent back on the next turn so the page stores nothing. */
  session?: string;
}

export interface AssistantTurn {
  messages: AssistantMessage[];
  projectId?: string;
  sessionId?: string;
  /** Resumes a backend-owned conversation; backends that replay `messages` ignore it. */
  session?: string;
}

export type AssistantEmit = (event: AssistantEvent) => void;

export interface AssistantBackend {
  id: string;
  label: string;
  /**
   * Runs one turn to completion, emitting events as it goes. A backend that wants the next
   * turn to carry its tool results emits `done` with the produced messages as JSON `content`.
   * Resolves when the turn is over; stops early when `signal` aborts.
   */
  chat(turn: AssistantTurn, emit: AssistantEmit, signal: AbortSignal): Promise<void>;
}

export interface AssistantBackendRegistry {
  register(backend: AssistantBackend): Dispose;
  get(backendId: string): AssistantBackend | undefined;
  list(): AssistantBackend[];
}

/** Last non-empty user message, for backends that keep their own transcript. */
export function latestUserMessage(turn: AssistantTurn): string {
  for (let index = turn.messages.length - 1; index >= 0; index -= 1) {
    const message = turn.messages[index];
    if (message.role === "user") {
      return message.content;
    }
  }
  return "";
}

declare module "@neoworks/extension-system" {
  interface Context {
    assistantBackends: AssistantBackendRegistry;
  }
}
