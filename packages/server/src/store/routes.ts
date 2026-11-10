import type { Context } from "@neoworks/extension-system";
import { HttpError } from "@atlas/contracts/server";
import type { RouteHandler } from "@atlas/contracts/server";
import type { StoreCore } from "./store";

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "the body is not valid JSON");
  }
}

function queryOf(request: Request, name: string): string | undefined {
  const value = new URL(request.url).searchParams.get(name);
  if (value === null) {
    return undefined;
  }
  return value;
}

function register(ctx: Context, method: string, pattern: string, handler: RouteHandler): void {
  ctx.effect(() => ctx.http.route(method, `/api/projects${pattern}`, handler), `route:${method} /api/projects${pattern}`);
}

function registerProjectRoutes(ctx: Context, store: StoreCore): void {
  register(ctx, "GET", "", () => store.projects.list());
  register(ctx, "POST", "", async (request) => store.projects.create(await readJson(request)));
  register(ctx, "GET", "/:project", (_request, params) => store.projects.require(params.project));
  register(ctx, "PATCH", "/:project", async (request, params) =>
    store.projects.patch(params.project, await readJson(request)),
  );
  register(ctx, "PUT", "/:project/taxonomy", async (request, params) =>
    store.projects.replaceTaxonomy(params.project, await readJson(request)),
  );
}

function registerPushRoutes(ctx: Context, store: StoreCore): void {
  register(ctx, "POST", "/:project/assets", async (request, params) =>
    store.media.pushAssets(params.project, await readJson(request)),
  );
  register(ctx, "POST", "/:project/items", async (request, params) =>
    store.media.pushItems(params.project, await readJson(request)),
  );
  register(ctx, "POST", "/:project/items/delete", async (request, params) =>
    store.media.deleteItems(params.project, await readJson(request)),
  );
  register(ctx, "POST", "/:project/suggestions", async (request, params) =>
    store.media.pushSuggestions(params.project, await readJson(request)),
  );
}

function registerReadRoutes(ctx: Context, store: StoreCore): void {
  register(ctx, "GET", "/:project/items", (request, params) =>
    store.items.list(params.project, {
      status: queryOf(request, "status"),
      cursor: queryOf(request, "cursor"),
      limit: queryOf(request, "limit"),
    }),
  );
  register(ctx, "GET", "/:project/items/:item", (_request, params) => store.items.detail(params.project, params.item));
  register(ctx, "GET", "/:project/queue/next", (request, params) =>
    store.items.queueNext(params.project, queryOf(request, "after")),
  );
}

function registerAnnotationRoutes(ctx: Context, store: StoreCore): void {
  register(ctx, "PUT", "/:project/items/:item/annotation", async (request, params) =>
    store.annotations.save(params.project, params.item, await readJson(request)),
  );
  register(ctx, "DELETE", "/:project/items/:item/annotation", (_request, params) => {
    store.annotations.remove(params.project, params.item);
  });
  register(ctx, "GET", "/:project/annotations", (request, params) =>
    store.annotations.feed(params.project, queryOf(request, "since"), queryOf(request, "limit")),
  );
}

/** HTTP surface of the store (docs/schema.md "HTTP API"); a plain plugin so its routes unload with it. */
export function StoreRoutes(ctx: Context): void {
  const store = ctx.store as unknown as StoreCore;
  registerProjectRoutes(ctx, store);
  registerPushRoutes(ctx, store);
  registerReadRoutes(ctx, store);
  registerAnnotationRoutes(ctx, store);
}

StoreRoutes.inject = ["http", "store"];

export default StoreRoutes;
