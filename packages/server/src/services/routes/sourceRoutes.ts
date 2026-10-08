import type { Context } from "@neoworks/extension-system";
import { HttpError } from "@atlas/contracts/server";
import type { SourcesService } from "@atlas/contracts/server";
import { addRoute, queryNumber, queryText } from "./helpers";
import type { SourcesCore } from "../sources";

async function listAllKinds(sources: SourcesService) {
  const kinds = [];
  for (const provider of sources.list()) {
    for (const kind of await provider.kinds()) {
      kinds.push({ ...kind, provider: provider.id });
    }
  }
  return kinds;
}

function searchOf(request: Request): string {
  const search = queryText(request, "search");
  if (search === undefined) {
    return "";
  }
  return search;
}

export function registerSourceRoutes(ctx: Context): void {
  const sources = ctx.sources as SourcesCore;

  addRoute(ctx, "GET", "/api/sources/kinds", () => listAllKinds(sources));

  addRoute(ctx, "GET", "/api/sources/:provider/:kind/items", async (request, params) => {
    const provider = sources.require(params.provider);
    if (!provider.list) {
      throw new HttpError(400, `source kind "${params.kind}" is not browsable`);
    }
    return provider.list(params.kind, {
      search: searchOf(request),
      limit: queryNumber(request, "limit", 40),
      offset: queryNumber(request, "offset", 0),
    });
  });
}
