import type { Context } from "@neoworks/extension-system";
import type { Item } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import type { Tool, ToolContent } from "@atlas/contracts/server";
import type { VideoTools } from "./ffmpeg";
import type { VideoMedia } from "./videoMedia";

export const SHEET_COLUMNS = 6;
export const SHEET_TILE_WIDTH = 240;
export const SHEET_TILE_HEIGHT = 135;
export const SHEET_MAX_TILES = 48;
export const SHEET_DEFAULT_TILES = 24;

export interface SheetTile {
  position: number;
  index: number;
  ref: string;
  status: string;
  start?: number;
  end?: number;
}

export interface SheetIndex {
  columns: number;
  total: number;
  from: number;
  tiles: SheetTile[];
}

export interface RenderedSheet {
  image: Uint8Array;
  index: SheetIndex;
}

/** Picks the items to show, clamped to the sheet's size. */
export function windowOf<T>(items: T[], from: number | undefined, count: number | undefined): T[] {
  const start = Math.max(Math.floor(from === undefined ? 0 : from), 0);
  if (start >= items.length) {
    return [];
  }
  let size = Math.floor(count === undefined ? 0 : count);
  if (size <= 0) {
    size = SHEET_DEFAULT_TILES;
  }
  return items.slice(start, start + Math.min(size, SHEET_MAX_TILES));
}

function tileOf(item: Item, position: number): SheetTile {
  const tile: SheetTile = { position, index: item.index, ref: item.ref, status: item.status };
  if (item.span !== undefined) {
    tile.start = item.span.start;
    tile.end = item.span.end;
  }
  return tile;
}

/** Renders a session at a glance for readers that can only look at one picture at a time. */
export class SheetRenderer {
  constructor(
    private readonly ctx: Context,
    private readonly media: VideoMedia,
    private readonly tools: VideoTools,
  ) {}

  /** Undefined when the window holds no items. */
  async render(sessionId: string, from?: number, count?: number): Promise<RenderedSheet | undefined> {
    if (this.ctx.items.getSession(sessionId) === undefined) {
      throw new HttpError(404, "session not found");
    }
    const all = this.ctx.items.list(sessionId);
    const selected = windowOf(all, from, count);
    if (selected.length === 0) {
      return undefined;
    }
    const posters = await Promise.all(selected.map((item) => this.posterOf(item)));
    const layout = { columns: Math.min(selected.length, SHEET_COLUMNS), tileWidth: SHEET_TILE_WIDTH, tileHeight: SHEET_TILE_HEIGHT };
    const image = await this.tools.tileImages(posters, layout);
    if (image === undefined) {
      throw new HttpError(502, "could not render the contact sheet");
    }
    const index: SheetIndex = {
      columns: SHEET_COLUMNS,
      total: all.length,
      from: Math.max(Math.floor(from === undefined ? 0 : from), 0),
      tiles: selected.map(tileOf),
    };
    return { image, index };
  }

  /** A missing poster leaves its cell dark rather than shifting everything after it. */
  private async posterOf(item: Item): Promise<string | undefined> {
    try {
      if (item.mediaKind === "video") {
        return await this.media.ensurePoster(item);
      }
      const location = await this.ctx.sources.locate(item);
      return location.kind === "file" ? location.path : undefined;
    } catch (error) {
      return undefined;
    }
  }
}

function numberArgument(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function sessionIdOf(args: Record<string, unknown>, contextSessionId: string | undefined): string {
  if (typeof args.sessionId === "string" && args.sessionId !== "") {
    return args.sessionId;
  }
  if (contextSessionId !== undefined) {
    return contextSessionId;
  }
  throw new Error("sessionId is required");
}

export function contactSheetTool(sheet: SheetRenderer): Tool {
  return {
    name: "contact_sheet",
    description:
      "A grid of thumbnails from a session, as an image, plus the index saying which item each cell holds. " +
      "One call shows what a session actually contains.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "session id (defaults to the current session)" },
        from: { type: "integer", description: "start at this item position (default 0)" },
        n: { type: "integer", description: `how many cells (default ${SHEET_DEFAULT_TILES}, max ${SHEET_MAX_TILES})` },
      },
    },
    async run(args, context) {
      const sessionId = sessionIdOf(args, context.sessionId);
      const rendered = await sheet.render(sessionId, numberArgument(args, "from"), numberArgument(args, "n"));
      if (rendered === undefined) {
        return [{ type: "text", text: JSON.stringify({ tiles: 0, note: "this session has no items to show" }) }];
      }
      const content: ToolContent[] = [
        { type: "text", text: JSON.stringify(rendered.index) },
        { type: "image", data: Buffer.from(rendered.image).toString("base64"), mimeType: "image/jpeg" },
      ];
      return content;
    },
  };
}
