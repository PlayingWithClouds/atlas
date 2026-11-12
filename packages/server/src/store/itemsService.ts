import type { ItemDetail, ItemFilterQuery, ItemPage, ModelOverview, QueueNext } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import { needsModel, readFilter } from "./itemFilter";
import type { ItemFilter } from "./itemFilter";
import type { ItemViews } from "./itemViews";
import type { ModelOverviewQuery } from "./modelOverview";
import { readCursor, readLimit } from "./query";
import type { ProjectsService } from "./projectsService";
import type { SuggestionsTable } from "./suggestionsTable";

const DEFAULT_PAGE_SIZE = 100;
const MAXIMUM_PAGE_SIZE = 1000;

/** Filter parameters as they arrive in a URL: all optional strings, checked by readFilter. */
export type ItemFilterQueryText = { [Key in keyof ItemFilterQuery]?: string };

export interface ItemListQuery extends ItemFilterQueryText {
  cursor?: string;
  limit?: string;
}

/** Reads of items for the labeling UI and adapters. */
export class ItemsService {
  constructor(
    private readonly views: ItemViews,
    private readonly overviews: ModelOverviewQuery,
    private readonly suggestions: SuggestionsTable,
    private readonly projects: ProjectsService,
  ) {}

  list(projectId: string, query: ItemListQuery): ItemPage {
    return this.views.page(projectId, {
      filter: this.filterOf(projectId, query),
      cursor: readCursor(query.cursor, "cursor"),
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

  queueNext(projectId: string, after: string | undefined, query: ItemFilterQueryText = {}): QueueNext {
    return this.views.queueNext(projectId, after, this.filterOf(projectId, query));
  }

  modelOverview(projectId: string): ModelOverview {
    const project = this.projects.require(projectId);
    return this.overviews.overview(projectId, this.modelSource(projectId), project.taxonomy);
  }

  private filterOf(projectId: string, query: ItemFilterQueryText): ItemFilter {
    const project = this.projects.require(projectId);
    const filter = readFilter(query as ItemFilterQuery, project.taxonomy);
    if (needsModel(filter)) {
      filter.modelSource = this.modelSource(projectId);
    }
    return filter;
  }

  /** The project's prefill source when set, otherwise whichever source last pushed values. */
  private modelSource(projectId: string): string | undefined {
    const project = this.projects.require(projectId);
    if (project.prefillSource !== undefined) {
      return project.prefillSource;
    }
    return this.suggestions.latestValueSource(projectId);
  }
}
