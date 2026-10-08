import type { Context } from "@neoworks/extension-system";
import type { ProjectConfig } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import { addRoute, readJsonObject, requireProject } from "./helpers";

export function registerProjectRoutes(ctx: Context): void {
  addRoute(ctx, "GET", "/api/projects", () => ctx.projects.list());

  addRoute(ctx, "POST", "/api/projects", async (request) => {
    const body = await readJsonObject(request);
    return ctx.projects.create(body.name as string, body.config as ProjectConfig);
  });

  addRoute(ctx, "GET", "/api/projects/:id", (_request, params) => requireProject(ctx, params.id));

  addRoute(ctx, "PUT", "/api/projects/:id", async (request, params) => {
    const body = await readJsonObject(request);
    if (body.name !== undefined && typeof body.name !== "string") {
      throw new HttpError(400, "name must be a string");
    }
    return ctx.projects.update(params.id, {
      name: body.name as string | undefined,
      config: body.config as Partial<ProjectConfig> | undefined,
    });
  });

  addRoute(ctx, "DELETE", "/api/projects/:id", (_request, params) => {
    requireProject(ctx, params.id);
    for (const session of ctx.items.listSessions(params.id)) {
      ctx.items.removeSession(session.id);
    }
    ctx.projects.remove(params.id);
    return { ok: true };
  });
}
