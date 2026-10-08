import type { Context } from "@neoworks/extension-system";
import type { Annotation, Item, Project, Session } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import type { RouteHandler } from "@atlas/contracts/server";

/** Registers a route inside the caller's effect scope so it unloads with the plugin. */
export function addRoute(ctx: Context, method: string, pattern: string, handler: RouteHandler): void {
  ctx.effect(() => ctx.http.route(method, pattern, handler), `route:${method} ${pattern}`);
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    throw new HttpError(400, "invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "body must be an object");
  }
  return body as Record<string, unknown>;
}

export function queryNumber(request: Request, name: string, fallback: number): number {
  const raw = new URL(request.url).searchParams.get(name);
  if (raw === null || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, `${name} must be a number`);
  }
  return parsed;
}

export function queryText(request: Request, name: string): string | undefined {
  const raw = new URL(request.url).searchParams.get(name);
  if (raw === null || raw === "") {
    return undefined;
  }
  return raw;
}

export function requireProject(ctx: Context, projectId: string): Project {
  const project = ctx.projects.get(projectId);
  if (!project) {
    throw new HttpError(404, "project not found");
  }
  return project;
}

export function requireSession(ctx: Context, sessionId: string): Session {
  const session = ctx.items.getSession(sessionId);
  if (!session) {
    throw new HttpError(404, "session not found");
  }
  return session;
}

export function requireItem(ctx: Context, itemId: string): Item {
  const item = ctx.items.get(itemId);
  if (!item) {
    throw new HttpError(404, "item not found");
  }
  return item;
}

export function projectOfSession(ctx: Context, session: Session): Project {
  return requireProject(ctx, session.projectId);
}

export function parseAnnotations(value: unknown): Annotation[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "annotations must be an array");
  }
  return value.map(parseAnnotation);
}

function parseAnnotation(value: unknown): Annotation {
  const candidate = value as { type?: unknown; value?: unknown };
  const isObject = typeof candidate === "object" && candidate !== null;
  if (!isObject || typeof candidate.type !== "string") {
    throw new HttpError(400, "each annotation needs a string type");
  }
  if (typeof candidate.value !== "object" || candidate.value === null || Array.isArray(candidate.value)) {
    throw new HttpError(400, "each annotation needs an object value");
  }
  return { type: candidate.type, value: candidate.value as Record<string, unknown> };
}
