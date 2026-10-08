import type { Context } from "@neoworks/extension-system";
import { HttpError } from "@atlas/contracts/server";
import type { AssistantBackend, AssistantEvent, AssistantMessage, AssistantTurn } from "./types";

export interface AssistantConfig {
  /** Backend id used when a request names none; defaults to the first registered. */
  defaultBackend?: string;
}

interface ChatBody {
  messages?: unknown;
  projectId?: unknown;
  sessionId?: unknown;
  session?: unknown;
  backend?: unknown;
}

function describe(ctx: Context, config: AssistantConfig) {
  const backends = ctx.assistantBackends.list().map((backend) => ({ id: backend.id, label: backend.label }));
  const tools = ctx.tools.list().map((tool) => ({ name: tool.name, description: tool.description }));
  return { enabled: backends.length > 0, backends, defaultBackend: pickBackend(ctx, config, undefined)?.id, tools };
}

function pickBackend(ctx: Context, config: AssistantConfig, requested: string | undefined): AssistantBackend | undefined {
  if (requested !== undefined) {
    return ctx.assistantBackends.get(requested);
  }
  if (config.defaultBackend !== undefined) {
    const configured = ctx.assistantBackends.get(config.defaultBackend);
    if (configured !== undefined) {
      return configured;
    }
  }
  return ctx.assistantBackends.list()[0];
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") {
    return value;
  }
  return undefined;
}

async function readChatBody(request: Request): Promise<ChatBody> {
  try {
    return (await request.json()) as ChatBody;
  } catch (error) {
    throw new HttpError(400, "invalid body");
  }
}

function buildTurn(body: ChatBody): AssistantTurn {
  if (!Array.isArray(body.messages)) {
    throw new HttpError(400, "messages must be an array");
  }
  return {
    messages: body.messages as AssistantMessage[],
    projectId: optionalString(body.projectId),
    sessionId: optionalString(body.sessionId),
    session: optionalString(body.session),
  };
}

function resolveBackend(ctx: Context, config: AssistantConfig, body: ChatBody): AssistantBackend {
  const requested = optionalString(body.backend);
  const backend = pickBackend(ctx, config, requested);
  if (backend !== undefined) {
    return backend;
  }
  if (requested !== undefined) {
    throw new HttpError(400, `unknown assistant backend "${requested}"`);
  }
  throw new HttpError(404, "no assistant backend is enabled");
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Streams one turn as server-sent events; the stream ending or the client leaving aborts the backend. */
function streamTurn(backend: AssistantBackend, turn: AssistantTurn, clientSignal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const controller = new AbortController();
  clientSignal.addEventListener("abort", () => controller.abort());
  let closed = false;
  let doneSent = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const emit = (event: AssistantEvent) => {
        if (closed) {
          return;
        }
        if (event.kind === "done") {
          doneSent = true;
        }
        streamController.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        await backend.chat(turn, emit, controller.signal);
      } catch (error) {
        emit({ kind: "error", content: messageOf(error) });
      }
      if (!doneSent) {
        emit({ kind: "done", content: "[]" });
      }
      if (!closed) {
        closed = true;
        streamController.close();
      }
    },
    cancel() {
      closed = true;
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

export function registerRoutes(ctx: Context, config: AssistantConfig): void {
  ctx.effect(() => ctx.http.route("GET", "/api/assistant", () => describe(ctx, config)), "route:GET /api/assistant");
  ctx.effect(
    () =>
      ctx.http.route("POST", "/api/assistant/chat", async (request) => {
        const body = await readChatBody(request);
        const turn = buildTurn(body);
        const backend = resolveBackend(ctx, config, body);
        return streamTurn(backend, turn, request.signal);
      }),
    "route:POST /api/assistant/chat",
  );
}
