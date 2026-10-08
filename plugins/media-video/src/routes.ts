import type { Context } from "@neoworks/extension-system";
import type { Item } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import type { RouteHandler } from "@atlas/contracts/server";
import { serveWholeVideo } from "./delivery";
import type { WholeVideoDependencies } from "./delivery";
import { resolveClipRange } from "./clipRange";
import { serveClip } from "./mediaKind";
import type { SheetRenderer } from "./sheet";
import type { VideoMedia } from "./videoMedia";

function addRoute(ctx: Context, method: string, pattern: string, handler: RouteHandler): void {
  ctx.effect(() => ctx.http.route(method, pattern, handler), `route:${method} ${pattern}`);
}

function requireVideoItem(ctx: Context, itemId: string): Item {
  const item = ctx.items.get(itemId);
  if (item === undefined) {
    throw new HttpError(404, "item not found");
  }
  if (item.mediaKind !== "video") {
    throw new HttpError(400, "item is not a video");
  }
  return item;
}

function optionalNumber(request: Request, name: string): number | undefined {
  const raw = new URL(request.url).searchParams.get(name);
  if (raw === null || raw === "") {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, `${name} must be a number`);
  }
  return parsed;
}

async function serveClipRoute(ctx: Context, media: VideoMedia, request: Request, itemId: string): Promise<Response> {
  const item = requireVideoItem(ctx, itemId);
  if (item.span === undefined) {
    throw new HttpError(400, "not a temporal span");
  }
  const override = { start: optionalNumber(request, "start"), end: optionalNumber(request, "end") };
  const span = resolveClipRange(item.span, override, await media.durationOf(item));
  return serveClip(media, item, span, request);
}

async function serveSheetRoute(sheet: SheetRenderer, request: Request, sessionId: string): Promise<Response> {
  const from = optionalNumber(request, "from");
  const count = optionalNumber(request, "n");
  const rendered = await sheet.render(sessionId, from, count);
  if (rendered === undefined) {
    throw new HttpError(404, "no items to show");
  }
  return new Response(new Uint8Array(rendered.image), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
  });
}

export function registerVideoRoutes(
  ctx: Context,
  media: VideoMedia,
  delivery: WholeVideoDependencies,
  sheet: SheetRenderer,
): void {
  addRoute(ctx, "GET", "/api/items/:id/clip", (request, params) => serveClipRoute(ctx, media, request, params.id));
  addRoute(ctx, "GET", "/api/items/:id/video", (request, params) =>
    serveWholeVideo(delivery, requireVideoItem(ctx, params.id), request),
  );
  addRoute(ctx, "GET", "/api/sessions/:id/sheet", (request, params) => serveSheetRoute(sheet, request, params.id));
}
