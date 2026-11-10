import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import type { Server, ServerWebSocket } from "bun";
import { HttpError, ValidationFailure } from "@atlas/contracts/server";
import type { Dispose, HttpService, RouteHandler } from "@atlas/contracts/server";
import { isAuthorized, LIVE_SOCKET_PATHS } from "./auth";
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
const HEALTH_PATH = "/api/health";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, *",
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

function unauthorizedResponse(): Response {
  const response = jsonResponse({ detail: "missing or invalid bearer token" }, 401);
  response.headers.set("www-authenticate", "Bearer");
  return response;
}

function errorToResponse(error: unknown): Response {
  if (error instanceof ValidationFailure) {
    return jsonResponse({ errors: error.errors }, 422);
  }
  if (error instanceof URIError) {
    return jsonResponse({ detail: "malformed percent-encoding in the path" }, 400);
  }
  if (error instanceof HttpError) {
    return jsonResponse({ detail: error.message }, error.status);
  }
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ detail: message }, 500);
}

export class HttpCore extends Service implements HttpService {
  static inject = ["workspace"];

  private readonly router = new Router();
  private readonly server: Server<unknown>;
  private webSocketHooks: WebSocketHooks | undefined;

  constructor(ctx: Context, options: HttpOptions = {}) {
    super(ctx, "http");
    const port = options.port === undefined ? DEFAULT_PORT : options.port;
    this.server = Bun.serve({
      port,
      // Bun drops requests idle for 10s by default; large batch pushes can take longer.
      idleTimeout: 0,
      fetch: (request, server) => this.handleRequest(request, server),
      websocket: {
        open: (socket) => this.webSocketHooks?.open(socket),
        close: (socket) => this.webSocketHooks?.close(socket),
        message: () => {},
      },
    });
    this.ctx.effect(() => () => this.shutdown(), "http:server");
    this.route("GET", HEALTH_PATH, () => ({ ok: true }));
  }

  get port(): number {
    return this.server.port as number;
  }

  route(method: string, pattern: string, handler: RouteHandler): Dispose {
    return this.router.add(method, pattern, handler);
  }

  /** Registers the single WebSocket owner for `/api/live` (and the older `/api/ws`). */
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
    const remoteAddress = server.requestIP(request)?.address;
    const url = new URL(request.url);
    if (LIVE_SOCKET_PATHS.includes(url.pathname) && this.webSocketHooks) {
      return this.upgrade(request, server, remoteAddress);
    }
    return this.respond(request, remoteAddress);
  }

  /** Authorizes and routes one request; `remoteAddress` is the peer's IP as seen by the socket. */
  async respond(request: Request, remoteAddress: string | undefined): Promise<Response> {
    const url = new URL(request.url);
    const startedAt = performance.now();
    const response = await this.dispatch(request, url, remoteAddress);
    this.logAccess(request, url, response, startedAt);
    return response;
  }

  private upgrade(request: Request, server: Server<unknown>, remoteAddress: string | undefined): Response | undefined {
    if (!this.isAllowed(request, remoteAddress)) {
      return unauthorizedResponse();
    }
    if (server.upgrade(request, { data: undefined })) {
      return undefined;
    }
    return jsonResponse({ detail: "websocket upgrade failed" }, 400);
  }

  private isAllowed(request: Request, remoteAddress: string | undefined): boolean {
    return isAuthorized(request, remoteAddress, this.ctx.workspace.config().tokens);
  }

  private async dispatch(request: Request, url: URL, remoteAddress: string | undefined): Promise<Response> {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }
    if (url.pathname !== HEALTH_PATH && !this.isAllowed(request, remoteAddress)) {
      return unauthorizedResponse();
    }
    try {
      return await this.runRoute(request, url);
    } catch (error) {
      return errorToResponse(error);
    }
  }

  private async runRoute(request: Request, url: URL): Promise<Response> {
    const match = this.router.match(request.method, url.pathname);
    if (!match) {
      return jsonResponse({ detail: "not found" }, 404);
    }
    return toResponse(await match.entry.handler(request, match.params));
  }

  private logAccess(request: Request, url: URL, response: Response, startedAt: number): void {
    if (process.env.ATLAS_ACCESS_LOG !== "1" || url.pathname === HEALTH_PATH) {
      return;
    }
    const elapsed = Math.round(performance.now() - startedAt);
    console.log(`${request.method} ${url.pathname} ${response.status} ${elapsed}ms`);
  }
}

export default HttpCore;
