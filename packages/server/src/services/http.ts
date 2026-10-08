import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import type { Server, ServerWebSocket } from "bun";
import { HttpError } from "@atlas/contracts/server";
import type { Dispose, HttpService, RouteHandler } from "@atlas/contracts/server";
import { Router } from "./router";

export interface HttpOptions {
  port?: number;
}

/** Lets one service (live) own the WebSocket connections that http upgrades. */
export interface WebSocketHooks {
  open(socket: ServerWebSocket<unknown>): void;
  close(socket: ServerWebSocket<unknown>): void;
}

const DEFAULT_PORT = 8123;
const WEBSOCKET_PATH = "/api/ws";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonResponse(body: unknown, status = 200): Response {
  return withCors(Response.json(body, { status }));
}

function toResponse(result: unknown): Response {
  if (result instanceof Response) {
    return withCors(result);
  }
  if (result === undefined) {
    return withCors(new Response(null, { status: 204 }));
  }
  return jsonResponse(result);
}

function errorToResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse({ detail: error.message }, error.status);
  }
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ detail: message }, 500);
}

export class HttpCore extends Service implements HttpService {
  private readonly router = new Router();
  private readonly server: Server<unknown>;
  private webSocketHooks: WebSocketHooks | undefined;

  constructor(ctx: Context, options: HttpOptions = {}) {
    super(ctx, "http");
    const port = options.port === undefined ? DEFAULT_PORT : options.port;
    this.server = Bun.serve({
      port,
      fetch: (request, server) => this.handleRequest(request, server),
      websocket: {
        open: (socket) => this.webSocketHooks?.open(socket),
        close: (socket) => this.webSocketHooks?.close(socket),
        message: () => {},
      },
    });
    this.ctx.effect(() => () => this.shutdown(), "http:server");
    this.route("GET", "/api/health", () => ({ ok: true }));
  }

  get port(): number {
    return this.server.port as number;
  }

  route(method: string, pattern: string, handler: RouteHandler): Dispose {
    return this.router.add(method, pattern, handler);
  }

  /** Registers the single WebSocket owner for `/api/ws`. */
  attachWebSocket(hooks: WebSocketHooks): Dispose {
    if (this.webSocketHooks) {
      throw new Error("a websocket handler is already attached");
    }
    this.webSocketHooks = hooks;
    return () => {
      if (this.webSocketHooks === hooks) {
        this.webSocketHooks = undefined;
      }
    };
  }

  private shutdown(): void {
    this.server.stop(true);
    this.router.clear();
    this.webSocketHooks = undefined;
  }

  private async handleRequest(request: Request, server: Server<unknown>): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === WEBSOCKET_PATH && this.webSocketHooks) {
      return this.upgrade(request, server);
    }
    const startedAt = performance.now();
    const response = await this.dispatch(request, url);
    this.logAccess(request, url, response, startedAt);
    return response;
  }

  private upgrade(request: Request, server: Server<unknown>): Response | undefined {
    if (server.upgrade(request, { data: undefined })) {
      return undefined;
    }
    return jsonResponse({ detail: "websocket upgrade failed" }, 400);
  }

  private async dispatch(request: Request, url: URL): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }
    const match = this.router.match(request.method, url.pathname);
    if (!match) {
      return jsonResponse({ detail: "not found" }, 404);
    }
    try {
      return toResponse(await match.entry.handler(request, match.params));
    } catch (error) {
      return errorToResponse(error);
    }
  }

  private logAccess(request: Request, url: URL, response: Response, startedAt: number): void {
    if (process.env.ATLAS_ACCESS_LOG !== "1" || url.pathname === "/api/health") {
      return;
    }
    const elapsed = Math.round(performance.now() - startedAt);
    console.log(`${request.method} ${url.pathname} ${response.status} ${elapsed}ms`);
  }
}

export default HttpCore;
