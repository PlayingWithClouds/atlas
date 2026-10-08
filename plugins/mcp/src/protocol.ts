import type { Context } from "@neoworks/extension-system";
import type { ToolContent } from "@atlas/contracts/server";
import { coerceArguments } from "./arguments";
import { exposedTools } from "./surface";

/**
 * The protocol version the tool surface is written against. A client asking for another one
 * still gets an answer; the handshake reports what the server supports and clients negotiate.
 */
export const PROTOCOL_VERSION = "2025-06-18";

export const CODE_PARSE = -32700;
export const CODE_INVALID_REQUEST = -32600;
export const CODE_METHOD_NOT_FOUND = -32601;

export interface McpConfig {
  allowWrites?: boolean;
}

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type JsonObject = Record<string, unknown>;
type RpcId = string | number | null;

function instructionsFor(allowWrites: boolean): string {
  const base =
    "Atlas is a general-purpose data labeling tool. Read the session, its label classes and its " +
    "model insights before suggesting anything. ";
  if (allowWrites) {
    return base + "Write tools are enabled on this server; use them only when the user asked for the change.";
  }
  return (
    base +
    "You can propose labels and save workflow drafts; you cannot run a workflow, confirm a label, " +
    "delete anything or change the label set. A human does that."
  );
}

function initializeResult(ctx: Context, allowWrites: boolean): JsonObject {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: "atlas", title: ctx.workspace.config().title, version: "0.1.0" },
    instructions: instructionsFor(allowWrites),
  };
}

function describeTools(ctx: Context, allowWrites: boolean): JsonObject {
  const tools = exposedTools(ctx.tools.list(), allowWrites).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return { tools };
}

function contentBlock(content: ToolContent): JsonObject {
  if (content.type === "image") {
    return { type: "image", data: content.data, mimeType: content.mimeType };
  }
  return { type: "text", text: content.text };
}

function failureResult(message: string): JsonObject {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** A failed tool is reported in-band: the model has to see what went wrong to correct itself. */
async function callTool(ctx: Context, allowWrites: boolean, params: unknown): Promise<JsonObject> {
  if (typeof params !== "object" || params === null || typeof (params as JsonObject).name !== "string") {
    throw new RpcError(CODE_INVALID_REQUEST, "malformed tools/call params");
  }
  const { name, arguments: rawArguments } = params as { name: string; arguments?: unknown };
  const tool = exposedTools(ctx.tools.list(), allowWrites).find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return failureResult(`unknown tool "${name}"`);
  }
  const args = coerceArguments(rawArguments, tool.inputSchema);
  const outcome = await ctx.tools.call(name, args, {});
  return { content: outcome.content.map(contentBlock), isError: outcome.isError };
}

export async function dispatch(ctx: Context, allowWrites: boolean, method: string, params: unknown): Promise<JsonObject> {
  switch (method) {
    case "initialize":
      return initializeResult(ctx, allowWrites);
    case "ping":
      return {};
    case "tools/list":
      return describeTools(ctx, allowWrites);
    case "tools/call":
      return callTool(ctx, allowWrites, params);
    default:
      throw new RpcError(CODE_METHOD_NOT_FOUND, `unsupported method ${method}`);
  }
}

function rpcResponse(id: RpcId, body: JsonObject): Response {
  return Response.json({ jsonrpc: "2.0", id, ...body });
}

function rpcFailure(id: RpcId, error: RpcError): Response {
  return rpcResponse(id, { error: { code: error.code, message: error.message } });
}

async function readRequestBody(request: Request): Promise<JsonObject | undefined> {
  try {
    const body = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return undefined;
    }
    return body as JsonObject;
  } catch (error) {
    return undefined;
  }
}

export async function handlePost(ctx: Context, allowWrites: boolean, request: Request): Promise<Response> {
  const body = await readRequestBody(request);
  if (body === undefined) {
    return rpcFailure(null, new RpcError(CODE_PARSE, "malformed JSON-RPC request"));
  }
  const id = body.id as RpcId | undefined;
  if (body.jsonrpc !== "2.0") {
    return rpcFailure(id === undefined ? null : id, new RpcError(CODE_INVALID_REQUEST, "expected jsonrpc 2.0"));
  }
  // Notifications carry no id and expect no body; the initialized handshake is one.
  if (id === undefined) {
    return new Response(null, { status: 202 });
  }
  try {
    const result = await dispatch(ctx, allowWrites, String(body.method), body.params);
    return rpcResponse(id, { result });
  } catch (error) {
    if (error instanceof RpcError) {
      return rpcFailure(id, error);
    }
    throw error;
  }
}

export function handleGet(): Response {
  return new Response("this MCP server is request/response only; POST JSON-RPC here", { status: 405 });
}
