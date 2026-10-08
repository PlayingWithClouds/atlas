import type { Context } from "@neoworks/extension-system";
import { classNamesOf } from "@atlas/contracts";
import type { Annotation, Project } from "@atlas/contracts";
import { withInteractiveDeadline } from "../deadline";
import { addRoute, requireProject } from "./helpers";

const CLASS_THUMBNAIL_TTL_MS = 30_000;

interface ThumbnailCacheEntry {
  expiresAt: number;
  thumbnails: Record<string, string>;
}

function trainingLabelsOf(ctx: Context, annotation: Annotation): string[] {
  const primitive = ctx.primitives.get(annotation.type);
  if (!primitive || !primitive.trainingLabels) {
    return [];
  }
  return primitive.trainingLabels(annotation.value);
}

/** First labeled item per class, in session and index order. */
function buildClassThumbnails(ctx: Context, project: Project): Record<string, string> {
  const thumbnails: Record<string, string> = {};
  for (const item of ctx.items.labeledInProject(project.id)) {
    for (const annotation of item.annotations) {
      for (const label of trainingLabelsOf(ctx, annotation)) {
        if (thumbnails[label] === undefined) {
          thumbnails[label] = `/api/items/${item.id}/thumbnail`;
        }
      }
    }
  }
  return thumbnails;
}

async function projectStats(ctx: Context, project: Project) {
  const sessions = ctx.items.summaries(project.id);
  const sessionIds = new Set(sessions.map((session) => session.id));
  const provider = ctx.models.get(project.config.model);
  let poolSize = 0;
  if (provider) {
    const state = await withInteractiveDeadline(provider.status(project.id, classNamesOf(project.config)), {
      poolSize: 0,
      trained: false,
    });
    poolSize = state.poolSize;
  }
  const activeJobs = ctx.jobs
    .list({ activeOnly: true })
    .filter((job) => job.sessionId !== undefined && sessionIds.has(job.sessionId));
  return {
    sessions: sessions.length,
    items: sessions.reduce((sum, session) => sum + session.total, 0),
    labeled: sessions.reduce((sum, session) => sum + session.labeled, 0),
    skipped: sessions.reduce((sum, session) => sum + session.skipped, 0),
    poolSize,
    activeJobs: activeJobs.length,
  };
}

export function registerInsightRoutes(ctx: Context): void {
  const thumbnailCache = new Map<string, ThumbnailCacheEntry>();
  ctx.effect(() => () => thumbnailCache.clear(), "cache:classThumbnails");

  addRoute(ctx, "GET", "/api/projects/:id/insights", (_request, params) => {
    const project = requireProject(ctx, params.id);
    return ctx.models.forProject(project).insights(project.id, classNamesOf(project.config));
  });

  addRoute(ctx, "GET", "/api/projects/:id/stats", (_request, params) => {
    return projectStats(ctx, requireProject(ctx, params.id));
  });

  addRoute(ctx, "GET", "/api/projects/:id/classes/thumbnails", (_request, params) => {
    const project = requireProject(ctx, params.id);
    const cached = thumbnailCache.get(project.id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.thumbnails;
    }
    const thumbnails = buildClassThumbnails(ctx, project);
    thumbnailCache.set(project.id, { expiresAt: Date.now() + CLASS_THUMBNAIL_TTL_MS, thumbnails });
    return thumbnails;
  });
}
