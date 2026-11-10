import type { ItemDetail, ItemPage, ItemStatus, QueueNext } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import type { ItemViews } from "./itemViews";
import { readCursor, readLimit } from "./query";
import type { ProjectsService } from "./projectsService";
import type { SuggestionsTable } from "./suggestionsTable";

const DEFAULT_PAGE_SIZE = 100;
const MAXIMUM_PAGE_SIZE = 1000;
const STATUSES: ItemStatus[] = ["pending", "labeled", "skipped"];

function readStatus(status: string | undefined): ItemStatus | undefined {
  if (status === undefined || status === "") {
    return undefined;
  }
  const match = STATUSES.find((candidate) => candidate === status);
  if (match === undefined) {
    throw new HttpError(400, "status must be pending, labeled or skipped");
  }
  return match;
}

export interface ItemListQuery {
  status?: string;
  cursor?: string;
  limit?: string;
}

/** Reads of items for the labeling UI and adapters. */
export class ItemsService {
  constructor(
    private readonly views: ItemViews,
    private readonly suggestions: SuggestionsTable,
    private readonly projects: ProjectsService,
  ) {}

  list(projectId: string, query: ItemListQuery): ItemPage {
    this.projects.require(projectId);
    return this.views.page(projectId, {
      status: readStatus(query.status),
      after: readCursor(query.cursor, "cursor"),
      limit: readLimit(query.limit, DEFAULT_PAGE_SIZE, MAXIMUM_PAGE_SIZE),
    });
  }

  detail(projectId: string, itemId: string): ItemDetail {
    this.projects.require(projectId);
    const view = this.views.get(projectId, itemId);
    if (view === undefined) {
      throw new HttpError(404, `item "${itemId}" not found`);
    }
    return {
      ...view,
      suggestions: this.suggestions.forItem(projectId, itemId),
      ...this.views.neighbours(projectId, itemId),
    };
  }

  queueNext(projectId: string, after: string | undefined): QueueNext {
    this.projects.require(projectId);
    return this.views.queueNext(projectId, after);
  }
}
