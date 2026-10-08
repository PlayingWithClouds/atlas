import type { Context } from "@neoworks/extension-system";
import { registerCatalogRoutes } from "./routes/catalogRoutes";
import { registerInsightRoutes } from "./routes/insightRoutes";
import { registerItemRoutes } from "./routes/itemRoutes";
import { registerProjectRoutes } from "./routes/projectRoutes";
import { registerSessionRoutes } from "./routes/sessionRoutes";
import { registerSourceRoutes } from "./routes/sourceRoutes";

/** HTTP surface of the domain services; a plain plugin so its routes unload with it. */
export function DomainRoutes(ctx: Context): void {
  registerCatalogRoutes(ctx);
  registerProjectRoutes(ctx);
  registerSourceRoutes(ctx);
  registerSessionRoutes(ctx);
  registerItemRoutes(ctx);
  registerInsightRoutes(ctx);
}

DomainRoutes.inject = ["http", "projects", "items", "sources", "mediaKinds", "primitives", "models", "labeling", "jobs", "notifications"];

export default DomainRoutes;
