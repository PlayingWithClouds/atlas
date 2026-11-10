import type { Annotation, Feed } from "@atlas/contracts";
import { itemLength, validateAnnotation } from "@atlas/contracts";
import { HttpError, ValidationFailure } from "@atlas/contracts/server";
import type { DbService } from "@atlas/contracts/server";
import type { AnnotationsTable } from "./annotationsTable";
import { DEFAULT_FEED_LIMIT, MAXIMUM_FEED_LIMIT } from "./annotationsTable";
import type { StoreEvents } from "./events";
import type { MediaTable } from "./mediaTable";
import { parseAnnotationInput } from "./parsing";
import { readCursor, readLimit } from "./query";
import type { ProjectsService } from "./projectsService";

export class AnnotationsService {
  constructor(
    private readonly db: DbService,
    private readonly annotations: AnnotationsTable,
    private readonly media: MediaTable,
    private readonly projects: ProjectsService,
    private readonly events: StoreEvents,
  ) {}

  save(projectId: string, itemId: string, raw: unknown): Annotation {
    const project = this.projects.require(projectId);
    const item = this.media.getItem(projectId, itemId);
    if (item === undefined) {
      throw new HttpError(404, `item "${itemId}" not found`);
    }
    const parsed = parseAnnotationInput(raw);
    if ("problems" in parsed) {
      throw new ValidationFailure(parsed.problems);
    }
    const asset = this.media.getAsset(projectId, item.assetId);
    const problems = validateAnnotation(project.taxonomy, parsed.value, itemLength(item, asset?.duration));
    if (problems.length > 0) {
      throw new ValidationFailure(problems);
    }
    const annotation: Annotation = {
      itemId,
      ...parsed.value,
      taxonomyVersion: project.taxonomy.version,
      updatedAt: new Date().toISOString(),
    };
    return this.commitSave(projectId, annotation);
  }

  /** Removing an annotation that is not there succeeds. */
  remove(projectId: string, itemId: string): void {
    this.projects.require(projectId);
    if (this.annotations.get(projectId, itemId) === undefined) {
      return;
    }
    const change = this.db.transaction(() => {
      this.annotations.delete(projectId, itemId);
      return this.annotations.logChange(projectId, itemId, "deleted", undefined);
    });
    this.events.emit({ type: "annotation", projectId, change }, { type: "projects" });
  }

  feed(projectId: string, since: string | undefined, limit: string | undefined): Feed {
    this.projects.require(projectId);
    return this.annotations.feed(projectId, readCursor(since, "since"), readLimit(limit, DEFAULT_FEED_LIMIT, MAXIMUM_FEED_LIMIT));
  }

  private commitSave(projectId: string, annotation: Annotation): Annotation {
    const change = this.db.transaction(() => {
      this.annotations.upsert(projectId, annotation);
      return this.annotations.logChange(projectId, annotation.itemId, "saved", annotation);
    });
    this.events.emit({ type: "annotation", projectId, change }, { type: "projects" });
    return annotation;
  }
}
