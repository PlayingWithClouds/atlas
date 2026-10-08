import type { Context } from "@neoworks/extension-system";
import type { ToolContent } from "@atlas/contracts/server";
import type { OllamaClient } from "./client";
import { LOOK_TOOL_NAME } from "./prompt";

export const CONTACT_SHEET_TOOL = "contact_sheet";

export const LOOK_TOOL_DESCRIPTION =
  "Look at a session's items and describe what is actually in them. Use this before recommending settings " +
  "or authoring a workflow; it is the only way to know whether a session is one static scene, a mix, or mostly junk.";

export const LOOK_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    sessionId: { type: "string", description: "session id" },
    from: { type: "integer", description: "start at this item position" },
    question: { type: "string", description: "what you want to know about them" },
  },
  required: ["sessionId"],
};

export interface SheetReading {
  image: ToolContent;
  tileCount: number;
  columns: number;
  total: number;
  from: number;
}

function parseIndex(text: string): { tiles?: unknown; columns?: unknown; total?: unknown; from?: unknown } {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    return {};
  }
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

/** Splits a contact_sheet result into its picture and the index describing the cells. */
export function readSheet(content: ToolContent[]): SheetReading | undefined {
  const image = content.find((block) => block.type === "image" && block.data !== undefined);
  if (image === undefined) {
    return undefined;
  }
  const index = parseIndex(textOfContent(content));
  let tileCount = 0;
  if (Array.isArray(index.tiles)) {
    tileCount = index.tiles.length;
  }
  return {
    image,
    tileCount,
    columns: numberOr(index.columns, tileCount),
    total: numberOr(index.total, tileCount),
    from: numberOr(index.from, 0),
  };
}

function textOfContent(content: ToolContent[]): string {
  return content
    .filter((block) => block.type === "text" && block.text !== undefined)
    .map((block) => block.text)
    .join("\n");
}

function questionOf(args: Record<string, unknown>): string {
  if (typeof args.question === "string" && args.question.trim() !== "") {
    return args.question;
  }
  return "Describe what these items show, and what they have in common.";
}

export interface LookDependencies {
  ctx: Context;
  client: OllamaClient;
  visionModel: string;
}

/**
 * Renders a contact sheet and asks the vision model to describe it. The description is what
 * comes back to the tool-calling model: it never handles the image itself.
 */
export async function look(
  dependencies: LookDependencies,
  args: Record<string, unknown>,
  toolContext: { projectId?: string; sessionId?: string },
  signal: AbortSignal,
): Promise<string> {
  const sheetArguments: Record<string, unknown> = { sessionId: args.sessionId };
  if (args.from !== undefined) {
    sheetArguments.from = args.from;
  }
  const outcome = await dependencies.ctx.tools.call(CONTACT_SHEET_TOOL, sheetArguments, toolContext);
  if (outcome.isError) {
    throw new Error(textOfContent(outcome.content));
  }
  const sheet = readSheet(outcome.content);
  if (sheet === undefined) {
    return "This session has no items to look at yet.";
  }
  const prompt =
    `This is a contact sheet: ${sheet.tileCount} thumbnails from one session, in order, ${sheet.columns} per row. ` +
    questionOf(args);
  const described = await dependencies.client.chat(
    dependencies.visionModel,
    [{ role: "user", content: prompt, images: [sheet.image.data as string] }],
    [],
    signal,
  );
  return `Looked at ${sheet.tileCount} of ${sheet.total} items (from position ${sheet.from}): ${described.content}`;
}

export function isLookTool(name: string): boolean {
  return name === LOOK_TOOL_NAME;
}
