import type { Context } from "@neoworks/extension-system";
import { addRoute } from "./helpers";

/** Read-only catalogs of what the loaded plugins provide, for create forms and capability checks. */
export function registerCatalogRoutes(ctx: Context): void {
  addRoute(ctx, "GET", "/api/media-kinds", () =>
    ctx.mediaKinds.list().map((mediaKind) => ({ id: mediaKind.id, label: mediaKind.label })),
  );

  addRoute(ctx, "GET", "/api/primitives", () =>
    ctx.primitives.list().map((primitive) => ({ id: primitive.id, label: primitive.label })),
  );

  addRoute(ctx, "GET", "/api/models", () =>
    ctx.models.list().map((model) => ({
      id: model.id,
      label: model.label,
      dim: model.dim,
      mediaKinds: model.mediaKinds,
      capabilities: model.capabilities,
    })),
  );
}
