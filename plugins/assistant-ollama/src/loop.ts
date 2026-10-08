import type { Context } from "@neoworks/extension-system";
import type { Tool } from "@atlas/contracts/server";
import type { AssistantEmit, AssistantMessage, AssistantTurn } from "@atlas/plugin-assistant/types";
import type { FunctionTool, OllamaClient } from "./client";
import type { ResolvedOllamaConfig } from "./config";
import { LOOK_TOOL_NAME, systemPrompt } from "./prompt";
import { isOffered } from "./surface";
import { CONTACT_SHEET_TOOL, LOOK_TOOL_DESCRIPTION, LOOK_TOOL_SCHEMA, isLookTool, look } from "./vision";

export interface LoopDependencies {
  ctx: Context;
  client: OllamaClient;
  config: ResolvedOllamaConfig;
}

type ToolCall = NonNullable<AssistantMessage["tool_calls"]>[number];
type ToolContext = { projectId?: string; sessionId?: string };

const SUMMARY_LIMIT = 240;

function offeredTools(ctx: Context): Tool[] {
  return ctx.tools.list().filter(isOffered);
}

/** The vision tool needs both a vision model and a registered contact sheet tool. */
export function canLook(ctx: Context, config: ResolvedOllamaConfig): boolean {
  if (config.visionModel === undefined) {
    return false;
  }
  return ctx.tools.list().some((tool) => tool.name === CONTACT_SHEET_TOOL);
}

function functionTool(name: string, description: string, parameters: Record<string, unknown>): FunctionTool {
  return { type: "function", function: { name, description, parameters } };
}

export function toolDefinitions(ctx: Context, config: ResolvedOllamaConfig): FunctionTool[] {
  const definitions = offeredTools(ctx).map((tool) => functionTool(tool.name, tool.description, tool.inputSchema));
  if (canLook(ctx, config)) {
    definitions.push(functionTool(LOOK_TOOL_NAME, LOOK_TOOL_DESCRIPTION, LOOK_TOOL_SCHEMA));
  }
  return definitions;
}

function propertiesOf(schema: Record<string, unknown>): Record<string, unknown> {
  if (typeof schema.properties !== "object" || schema.properties === null) {
    return {};
  }
  return schema.properties as Record<string, unknown>;
}

/** Supplies the session and project the page is open on when the model left them out. */
export function fillContext(args: Record<string, unknown>, schema: Record<string, unknown>, turn: AssistantTurn): void {
  const properties = propertiesOf(schema);
  if (args.sessionId === undefined && turn.sessionId !== undefined && "sessionId" in properties) {
    args.sessionId = turn.sessionId;
  }
  if (args.projectId === undefined && turn.projectId !== undefined && "projectId" in properties) {
    args.projectId = turn.projectId;
  }
}

function schemaOf(ctx: Context, name: string): Record<string, unknown> {
  if (isLookTool(name)) {
    return LOOK_TOOL_SCHEMA;
  }
  const tool = ctx.tools.list().find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return {};
  }
  return tool.inputSchema;
}

function describeArguments(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (key === "graph") {
      parts.push("graph=…");
      continue;
    }
    if (typeof value === "string") {
      parts.push(`${key}=${value}`);
      continue;
    }
    parts.push(`${key}=${JSON.stringify(value)}`);
  }
  return parts.join(" ");
}

/** Keeps a tool result readable in the transcript; the model still gets all of it. */
export function summarize(text: string): string {
  if (text.length <= SUMMARY_LIMIT) {
    return text;
  }
  return `${text.slice(0, SUMMARY_LIMIT)}…`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Strips reasoning from a reply before it is replayed into the next turn, except on a turn that
 * called a tool, where the reasoning is what connects the call to the result that follows it.
 */
export function forHistory(reply: AssistantMessage): AssistantMessage {
  if (reply.tool_calls !== undefined && reply.tool_calls.length > 0) {
    return reply;
  }
  const { thinking: _thinking, ...withoutThinking } = reply;
  return withoutThinking;
}

function emptyAnswerReason(reply: AssistantMessage): string {
  if (reply.thinking !== undefined && reply.thinking !== "") {
    return "The model reasoned but never wrote an answer. Ask again, or turn thinking off.";
  }
  return "The model returned an empty answer. Ask again.";
}

async function executeTool(
  dependencies: LoopDependencies,
  name: string,
  args: Record<string, unknown>,
  toolContext: ToolContext,
  signal: AbortSignal,
): Promise<string> {
  const { ctx, client, config } = dependencies;
  if (isLookTool(name) && canLook(ctx, config)) {
    return look({ ctx, client, visionModel: config.visionModel as string }, args, toolContext, signal);
  }
  const tool = offeredTools(ctx).find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return `error: unknown tool "${name}"`;
  }
  const outcome = await ctx.tools.call(name, args, toolContext);
  // Images are dropped on purpose: the tool-calling model is never shown pictures.
  const text = outcome.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (outcome.isError) {
    return `error: ${text}`;
  }
  return text;
}

/**
 * Runs one tool call and returns the message carrying its result. A failure comes back as the
 * result rather than ending the turn: the model has to see what went wrong to try something else.
 */
async function runTool(
  dependencies: LoopDependencies,
  turn: AssistantTurn,
  call: ToolCall,
  emit: AssistantEmit,
  signal: AbortSignal,
): Promise<AssistantMessage> {
  const name = call.function.name;
  const args = { ...call.function.arguments };
  fillContext(args, schemaOf(dependencies.ctx, name), turn);
  emit({ kind: "tool", tool: name, detail: describeArguments(args) });

  let text: string;
  try {
    text = await executeTool(dependencies, name, args, { projectId: turn.projectId, sessionId: turn.sessionId }, signal);
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    text = `error: tool ${name} failed: ${messageOf(error)}`;
  }
  emit({ kind: "tool_result", tool: name, detail: summarize(text) });
  return { role: "tool", tool_name: name, content: text };
}

/**
 * Drives one turn to completion against the model and returns the messages to append to the
 * transcript. Model replies are bounded: a small local model that loops on a tool it
 * misunderstands would otherwise never stop.
 */
export async function runTurn(
  dependencies: LoopDependencies,
  turn: AssistantTurn,
  emit: AssistantEmit,
  signal: AbortSignal,
): Promise<AssistantMessage[]> {
  const { ctx, client, config } = dependencies;
  const prompt = systemPrompt({ projectId: turn.projectId, sessionId: turn.sessionId, canLook: canLook(ctx, config) });
  const messages: AssistantMessage[] = [{ role: "system", content: prompt }, ...turn.messages];
  const definitions = toolDefinitions(ctx, config);
  const produced: AssistantMessage[] = [];

  for (let round = 0; round < config.maxToolCalls; round += 1) {
    let reply: AssistantMessage;
    try {
      reply = await client.chat(config.model, messages, definitions, signal);
    } catch (error) {
      if (!signal.aborted) {
        emit({ kind: "error", content: messageOf(error) });
      }
      return produced;
    }
    if (reply.thinking !== undefined && reply.thinking !== "") {
      emit({ kind: "thinking", content: reply.thinking });
    }
    const remembered = forHistory(reply);
    messages.push(remembered);
    produced.push(remembered);

    const calls = reply.tool_calls;
    if (calls === undefined || calls.length === 0) {
      // A reply with no tool call and nothing to say would render as an empty bubble.
      if (reply.content.trim() === "") {
        emit({ kind: "error", content: emptyAnswerReason(reply) });
        return produced;
      }
      emit({ kind: "message", content: reply.content });
      return produced;
    }
    for (const call of calls) {
      const result = await runTool(dependencies, turn, call, emit, signal);
      messages.push(result);
      produced.push(result);
    }
  }

  emit({
    kind: "error",
    content: `Stopped after ${config.maxToolCalls} tool calls without an answer. The model may be looping.`,
  });
  return produced;
}
