import path from "node:path";
import type { Context } from "@neoworks/extension-system";
import type { Project } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import type { SourceProvider } from "@atlas/contracts/server";
import { readLabels, requestedPath } from "./dataset";
import { runExport } from "./exporter";
import { runImport } from "./importer";

function timestampOf(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (error) {
    return {};
  }
}

function requireProject(ctx: Context, projectId: string): Project {
  const project = ctx.projects.get(projectId);
  if (project === undefined) {
    throw new HttpError(404, "project not found");
  }
  return project;
}

function rejectIfRunning(ctx: Context, jobType: string): void {
  if (ctx.jobs.isRunning(jobType)) {
    throw new HttpError(409, `a ${jobType} job is already running`);
  }
}

async function startExport(ctx: Context, request: Request, params: Record<string, string>) {
  const project = requireProject(ctx, params.id);
  rejectIfRunning(ctx, "export");
  const body = await readBody(request);
  const defaultDirectory = path.join(ctx.workspace.directory, "exports", `${project.id}-${timestampOf(new Date())}`);
  const directory = requestedPath(body) ?? defaultDirectory;
  const job = ctx.jobs.submit({ type: "export", extra: { projectId: project.id, directory } }, async (handle) => {
    const summary = await runExport({ items: ctx.items, sources: ctx.sources }, project, directory, handle);
    handle.setExtra({ projectId: project.id, directory, ...summary });
  });
  return { ok: true, directory, job };
}

async function startImport(ctx: Context, provider: SourceProvider, request: Request, params: Record<string, string>) {
  const project = requireProject(ctx, params.id);
  rejectIfRunning(ctx, "import");
  const directory = requestedPath(await readBody(request));
  if (directory === undefined) {
    throw new HttpError(400, "path is required");
  }
  readLabels(directory);
  const job = ctx.jobs.submit({ type: "import", extra: { projectId: project.id, directory } }, async (handle) => {
    const summary = await runImport({ items: ctx.items, labeling: ctx.labeling, provider }, project, directory, handle);
    handle.setExtra({ projectId: project.id, directory, ...summary });
  });
  return { ok: true, directory, job };
}

export function registerRoutes(ctx: Context, provider: SourceProvider): void {
  ctx.effect(
    () => ctx.http.route("POST", "/api/projects/:id/export", (request, params) => startExport(ctx, request, params)),
    "route:POST /api/projects/:id/export",
  );
  ctx.effect(
    () =>
      ctx.http.route("POST", "/api/projects/:id/import", (request, params) =>
        startImport(ctx, provider, request, params),
      ),
    "route:POST /api/projects/:id/import",
  );
}
