/**
 * Atlas plugin SDK (TypeScript / Bun) — write a plugin as a JSON-RPC 2.0 HTTP service.
 *
 * A plugin exposes a single POST /rpc endpoint. This helper handles the envelope + the
 * mandatory `capabilities()` handshake, so a plugin is just a set of methods plus its
 * declared capabilities:
 *
 *     import { Plugin } from "@atlas/plugin-sdk";
 *
 *     const plugin = new Plugin("veil");
 *     plugin.declare("source", { kinds: ["gallery", "scene"], browsable: true });
 *     plugin.method("source.list", async ({ kind, search, limit, offset }) => ({ items: [] }));
 *     plugin.serve(9101);
 *
 * Methods receive the RPC `params` as a single object argument and return a
 * JSON-serializable result (sync or async). Throwing becomes a JSON-RPC error reply.
 *
 * Wire-compatible peer of the Python SDK in `sdk/python`.
 */

export type RpcParams = Record<string, unknown>;
export type Handler = (params: RpcParams) => unknown | Promise<unknown>;

interface Capability {
  name: string;
  [key: string]: unknown;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: RpcParams;
}

export class Plugin {
  readonly name: string;
  private methods = new Map<string, Handler>();
  private capabilities: Capability[] = [];

  constructor(name: string) {
    this.name = name;
  }

  /** Advertise a capability (name + arbitrary descriptor fields). */
  declare(capability: string, info: Record<string, unknown> = {}): void {
    this.capabilities.push({ name: capability, ...info });
  }

  /** Register a handler for an RPC method name. */
  method(rpcName: string, handler: Handler): void {
    this.methods.set(rpcName, handler);
  }

  private async handle(body: RpcRequest): Promise<Record<string, unknown>> {
    const id = body.id ?? null;
    const method = body.method;
    const params = body.params ?? {};

    if (method === "capabilities") {
      return {
        jsonrpc: "2.0",
        id,
        result: { plugin: this.name, capabilities: this.capabilities },
      };
    }

    const fn = method ? this.methods.get(method) : undefined;
    if (!fn) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      };
    }

    try {
      const result = await fn(params);
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { jsonrpc: "2.0", id, error: { code: -32000, message } };
    }
  }

  /** Start the HTTP server (Bun.serve): POST /rpc + GET /health. */
  serve(port: number): void {
    const name = this.name;
    const handle = this.handle.bind(this);

    Bun.serve({
      port,
      async fetch(request) {
        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/health") {
          return Response.json({ ok: true, plugin: name });
        }

        if (request.method === "POST" && url.pathname === "/rpc") {
          let body: RpcRequest;
          try {
            body = (await request.json()) as RpcRequest;
          } catch {
            return Response.json(
              { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
              { status: 400 },
            );
          }
          return Response.json(await handle(body));
        }

        return new Response("not found", { status: 404 });
      },
    });

    console.log(`[${name}] plugin listening on :${port}`);
  }
}
