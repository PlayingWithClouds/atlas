import type { Context } from "@neoworks/extension-system";
import { classNamesOf } from "@atlas/contracts";
import type { Item, ItemStatus, Session, SourceRef } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import type { ModelProvider } from "@atlas/contracts/server";
import type { SourcesCore } from "../sources";
import {
  addRoute,
  projectOfSession,
  queryNumber,
  queryText,
  readJsonObject,
  requireProject,
  requireSession,
} from "./helpers";

const ITEM_STATUSES: ItemStatus[] = ["pending", "labeled", "skipped"];
const DEFAULT_DUPLICATE_THRESHOLD = 0.93;
const DEFAULT_SEARCH_LIMIT = 60;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

function parseSourceRef(value: unknown): SourceRef {
  const candidate = value as Partial<SourceRef> | null;
  if (typeof candidate !== "object" || candidate === null) {
    throw new HttpError(400, "source is required");
  }
  if (typeof candidate.plugin !== "string" || typeof candidate.kind !== "string") {
    throw new HttpError(400, "source.plugin and source.kind are required");
  }
  const params = candidate.params;
  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
    throw new HttpError(400, "source.params must be an object");
  }
  return { plugin: candidate.plugin, kind: candidate.kind, params: params === undefined ? {} : params };
}

function findResumable(ctx: Context, projectId: string, source: SourceRef): Session | undefined {
  const wanted = stableJson(source);
  return ctx.items.listSessions(projectId).find((session) => stableJson(session.source) === wanted);
}

async function createSessionFromSource(ctx: Context, projectId: string, source: SourceRef): Promise<Session> {
  const provider = (ctx.sources as SourcesCore).require(source.plugin);
  let resolved;
  try {
    resolved = await provider.resolve(source.kind, source.params);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new HttpError(502, `source could not be resolved: ${detail}`);
  }
  const session = ctx.items.createSession({
    projectId,
    label: resolved.label,
    source,
    meta: resolved.sessionMeta,
  });
  ctx.items.append(session.id, resolved.items);
  return session;
}

async function openSession(ctx: Context, request: Request) {
  const body = await readJsonObject(request);
  if (typeof body.projectId !== "string") {
    throw new HttpError(400, "projectId is required");
  }
  requireProject(ctx, body.projectId);
  const source = parseSourceRef(body.source);
  const existing = findResumable(ctx, body.projectId, source);
  if (existing) {
    return { ...(await ctx.items.status(existing.id)), resumed: true };
  }
  const session = await createSessionFromSource(ctx, body.projectId, source);
  return { ...(await ctx.items.status(session.id)), resumed: false };
}

async function sortByUncertainty(ctx: Context, session: Session, items: Item[]): Promise<Item[]> {
  const project = projectOfSession(ctx, session);
  const provider = ctx.models.get(project.config.model);
  const embedded = items.filter((item) => item.embedded);
  if (!provider || embedded.length === 0) {
    return items;
  }
  const refs = embedded.map((item) => item.ref);
  const ranking = await provider.rank(project.id, refs, classNamesOf(project.config));
  const byRef = new Map(embedded.map((item) => [item.ref, item]));
  const ranked = ranking.order.map((ref) => byRef.get(ref)).filter((item): item is Item => item !== undefined);
  const rankedIds = new Set(ranked.map((item) => item.id));
  return [...ranked, ...items.filter((item) => !rankedIds.has(item.id))];
}

function parseStatusFilter(request: Request): ItemStatus | undefined {
  const raw = queryText(request, "status");
  if (raw === undefined) {
    return undefined;
  }
  if (!ITEM_STATUSES.includes(raw as ItemStatus)) {
    throw new HttpError(400, `status must be one of ${ITEM_STATUSES.join(", ")}`);
  }
  return raw as ItemStatus;
}

async function listSessionItems(ctx: Context, request: Request, sessionId: string): Promise<Item[]> {
  const session = requireSession(ctx, sessionId);
  const items = ctx.items.list(sessionId, { status: parseStatusFilter(request) });
  if (queryText(request, "sort") === "uncertainty") {
    return sortByUncertainty(ctx, session, items);
  }
  return items;
}

function embeddedItemsWithProvider(ctx: Context, sessionId: string) {
  const session = requireSession(ctx, sessionId);
  const project = projectOfSession(ctx, session);
  const provider: ModelProvider = ctx.models.forProject(project);
  const items = ctx.items.list(sessionId, { embedded: true });
  return { project, provider, items, idByRef: new Map(items.map((item) => [item.ref, item.id])) };
}

async function findDuplicates(ctx: Context, request: Request, sessionId: string) {
  const { project, provider, items, idByRef } = embeddedItemsWithProvider(ctx, sessionId);
  const threshold = queryNumber(request, "threshold", DEFAULT_DUPLICATE_THRESHOLD);
  const groups = await provider.duplicates(project.id, items.map((item) => item.ref), threshold);
  return groups.map((group) => ({
    keep: idByRef.get(group.keep),
    duplicates: group.duplicates.map((ref) => idByRef.get(ref)),
  }));
}

async function searchSession(ctx: Context, request: Request, sessionId: string) {
  const { project, provider, items, idByRef } = embeddedItemsWithProvider(ctx, sessionId);
  if (!provider.capabilities.textSearch || !provider.search) {
    throw new HttpError(503, `model provider "${provider.id}" does not support text search`);
  }
  const query = queryText(request, "q");
  if (query === undefined) {
    throw new HttpError(400, "q is required");
  }
  const limit = queryNumber(request, "limit", DEFAULT_SEARCH_LIMIT);
  const hits = await provider.search(project.id, query, items.map((item) => item.ref), limit);
  return hits.map((hit) => ({ itemId: idByRef.get(hit.ref), score: hit.score }));
}

export function registerSessionRoutes(ctx: Context): void {
  addRoute(ctx, "POST", "/api/sessions", (request) => openSession(ctx, request));

  addRoute(ctx, "GET", "/api/sessions", (request) => ctx.items.summaries(queryText(request, "projectId")));

  addRoute(ctx, "GET", "/api/sessions/:id", (_request, params) => {
    requireSession(ctx, params.id);
    return ctx.items.status(params.id);
  });

  addRoute(ctx, "DELETE", "/api/sessions/:id", (_request, params) => {
    ctx.items.removeSession(params.id);
    return { ok: true };
  });

  addRoute(ctx, "GET", "/api/sessions/:id/next", (_request, params) => ctx.labeling.next(params.id));

  addRoute(ctx, "GET", "/api/sessions/:id/items", (request, params) => listSessionItems(ctx, request, params.id));

  addRoute(ctx, "GET", "/api/sessions/:id/duplicates", (request, params) => findDuplicates(ctx, request, params.id));

  addRoute(ctx, "GET", "/api/sessions/:id/search", (request, params) => searchSession(ctx, request, params.id));
}
