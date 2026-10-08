import type { Context } from "@neoworks/extension-system";
import type { Item, Project, Span } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import { addRoute, parseAnnotations, projectOfSession, readJsonObject, requireItem, requireSession } from "./helpers";

const SUGGESTION_THRESHOLD = 0.5;
const MINIMUM_SPAN_SECONDS = 0.25;

function projectOfItem(ctx: Context, item: Item): Project {
  return projectOfSession(ctx, requireSession(ctx, item.sessionId));
}

/** Best effort: a model that is missing or failing must not block item edits. */
async function forgetInModel(ctx: Context, item: Item): Promise<void> {
  const project = projectOfItem(ctx, item);
  const provider = ctx.models.get(project.config.model);
  if (!provider) {
    return;
  }
  try {
    await provider.forget(project.id, [item.ref]);
  } catch (error) {
    ctx.notifications.persist({
      key: `forget-error:${project.id}`,
      message: `Model could not forget a removed reference: ${error instanceof Error ? error.message : String(error)}`,
      level: "error",
    });
  }
}

/** Fire-and-forget: the HTTP response must not wait on the model worker. */
function forgetInBackground(ctx: Context, item: Item): void {
  forgetInModel(ctx, item).catch(() => {
    // forgetInModel reports provider failures itself; nothing else can be done here.
  });
}

function parseSpan(body: Record<string, unknown>): Span {
  const start = body.start;
  const end = body.end;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) {
    throw new HttpError(400, "start and end must be numbers");
  }
  if (start < 0 || end - start < MINIMUM_SPAN_SECONDS) {
    throw new HttpError(400, `span must be at least ${MINIMUM_SPAN_SECONDS}s long`);
  }
  return { start, end };
}

async function changeSpan(ctx: Context, request: Request, itemId: string): Promise<Item> {
  const item = requireItem(ctx, itemId);
  const span = parseSpan(await readJsonObject(request));
  const updated = ctx.items.setSpan(itemId, span);
  forgetInBackground(ctx, item);
  return updated;
}

async function describeItemForClient(ctx: Context, itemId: string) {
  const item = requireItem(ctx, itemId);
  ctx.emit("item/opened", item);
  const suggestions = await ctx.labeling.suggestions(item);
  return { item, suggestions, threshold: SUGGESTION_THRESHOLD };
}

function requireMediaKind(ctx: Context, item: Item) {
  const mediaKind = ctx.mediaKinds.get(item.mediaKind);
  if (!mediaKind) {
    throw new HttpError(503, `media kind "${item.mediaKind}" is not loaded`);
  }
  return mediaKind;
}

function serveThumbnail(ctx: Context, request: Request, itemId: string): Promise<Response> {
  const item = requireItem(ctx, itemId);
  const mediaKind = requireMediaKind(ctx, item);
  if (mediaKind.thumbnail) {
    return mediaKind.thumbnail(item, request);
  }
  return mediaKind.serve(item, request);
}

export function registerItemRoutes(ctx: Context): void {
  addRoute(ctx, "GET", "/api/items/:id", (_request, params) => describeItemForClient(ctx, params.id));

  addRoute(ctx, "POST", "/api/items/:id/label", async (request, params) => {
    const body = await readJsonObject(request);
    return ctx.labeling.confirm(params.id, parseAnnotations(body.annotations));
  });

  addRoute(ctx, "POST", "/api/items/:id/skip", (_request, params) => {
    const skipped = ctx.labeling.skip(params.id);
    ctx.emit("item/rejected", skipped);
    return skipped;
  });

  addRoute(ctx, "DELETE", "/api/items/:id", (_request, params) => {
    const item = requireItem(ctx, params.id);
    ctx.items.remove(params.id);
    forgetInBackground(ctx, item);
    return { ok: true };
  });

  addRoute(ctx, "PATCH", "/api/items/:id/span", (request, params) => changeSpan(ctx, request, params.id));

  addRoute(ctx, "GET", "/api/items/:id/media", (request, params) => {
    const item = requireItem(ctx, params.id);
    return requireMediaKind(ctx, item).serve(item, request);
  });

  addRoute(ctx, "GET", "/api/items/:id/thumbnail", (request, params) => serveThumbnail(ctx, request, params.id));
}
