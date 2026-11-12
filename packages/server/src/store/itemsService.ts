import type { ItemDetail, ItemFilterQuery, ItemPage, ModelOverview, QueueNext, SemanticSearch, SimilarItem } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import { needsModel, readFilter, readMargin } from "./itemFilter";
import type { ItemFilter } from "./itemFilter";
import type { ItemViews } from "./itemViews";
import type { ModelOverviewQuery } from "./modelOverview";
import { readCursor, readLimit } from "./query";
import type { ProjectsService } from "./projectsService";
import type { SuggestionsTable } from "./suggestionsTable";

const DEFAULT_PAGE_SIZE = 100;
const MAXIMUM_PAGE_SIZE = 1000;
/** Items a search returns at most; the rest drop out of a `similar` or `like` list. */
const SIMILAR_LIMIT = 2000;
const SIMILAR_TIMEOUT_MS = 15000;
/** Paging through one search asks the adapter once. */
const SIMILAR_CACHE_MS = 5 * 60 * 1000;
const SIMILAR_CACHE_SIZE = 20;

/** Filter parameters as they arrive in a URL: all optional strings, checked by readFilter. */
export type ItemFilterQueryText = { [Key in keyof ItemFilterQuery]?: string };

interface CachedSearch {
  items: SimilarItem[];
  at: number;
}

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

  private readonly searches = new Map<string, CachedSearch>();

  async list(projectId: string, query: ItemListQuery): Promise<ItemPage> {
    return this.views.page(projectId, {
      filter: await this.filterOf(projectId, query),
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

  async queueNext(projectId: string, after: string | undefined, query: ItemFilterQueryText = {}): Promise<QueueNext> {
    return this.views.queueNext(projectId, after, await this.filterOf(projectId, query));
  }

  modelOverview(projectId: string, margin?: string): ModelOverview {
    const project = this.projects.require(projectId);
    return this.overviews.overview(projectId, this.modelSource(projectId), project.taxonomy, readMargin(margin));
  }

  private async filterOf(projectId: string, query: ItemFilterQueryText): Promise<ItemFilter> {
    const project = this.projects.require(projectId);
    const filter = readFilter(query as ItemFilterQuery, project.taxonomy);
    if (needsModel(filter)) {
      filter.modelSource = this.modelSource(projectId);
    }
    const request = searchRequestOf(filter, project.semanticSearch);
    if (request !== undefined) {
      filter.similarItems = await this.similarItems(request);
    }
    return filter;
  }

  /** The adapter's answer for a description or an example item, kept a few minutes so paging asks once. */
  private async similarItems(request: SearchRequest): Promise<SimilarItem[]> {
    const key = `${request.url}\u0000${request.parameter}\u0000${request.value}`;
    const cached = this.searches.get(key);
    if (cached !== undefined && Date.now() - cached.at < SIMILAR_CACHE_MS) {
      return cached.items;
    }
    const items = await fetchSimilar(request);
    this.searches.set(key, { items, at: Date.now() });
    if (this.searches.size > SIMILAR_CACHE_SIZE) {
      const oldest = this.searches.keys().next().value;
      if (oldest !== undefined) {
        this.searches.delete(oldest);
      }
    }
    return items;
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

interface SearchRequest {
  url: string;
  /** q: by description; item: by example. */
  parameter: "q" | "item";
  value: string;
}

/** What to ask the project's search for a `similar` or `like` filter, checked against what it can do. */
function searchRequestOf(filter: ItemFilter, search: SemanticSearch | undefined): SearchRequest | undefined {
  if (filter.similar === undefined && filter.like === undefined) {
    return undefined;
  }
  if (filter.similar !== undefined && filter.like !== undefined) {
    throw new HttpError(400, "similar and like cannot be combined");
  }
  if (search === undefined) {
    throw new HttpError(400, "this project has no search (an adapter sets semanticSearch)");
  }
  if (filter.like !== undefined) {
    if (search.byExample !== true) {
      throw new HttpError(400, "this project's search cannot find items by example");
    }
    return { url: search.url, parameter: "item", value: filter.like };
  }
  if (search.byText !== true) {
    throw new HttpError(400, "this project's search cannot find items by description");
  }
  return { url: search.url, parameter: "q", value: filter.similar as string };
}

async function fetchSimilar(request: SearchRequest): Promise<SimilarItem[]> {
  const target = new URL(request.url);
  target.searchParams.set(request.parameter, request.value);
  target.searchParams.set("limit", String(SIMILAR_LIMIT));
  let response: Response;
  try {
    response = await fetch(target, { signal: AbortSignal.timeout(SIMILAR_TIMEOUT_MS) });
  } catch (failure) {
    throw new HttpError(502, `semantic search is unreachable: ${String(failure)}`);
  }
  if (!response.ok) {
    throw new HttpError(502, `semantic search answered ${response.status}`);
  }
  return similarItemsOf(await response.json());
}

/** Keeps the well-formed entries of an adapter answer `{ items: { itemId, score }[] }`. */
function similarItemsOf(body: unknown): SimilarItem[] {
  if (body === null || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items)) {
    throw new HttpError(502, "semantic search answered without an items list");
  }
  const entries = (body as { items: unknown[] }).items;
  return entries.filter(isSimilarItem).map(cleanSimilarItem);
}

/** Only the fields atlas reads; an `at` that is no finite number is dropped. */
function cleanSimilarItem(entry: SimilarItem): SimilarItem {
  const item: SimilarItem = { itemId: entry.itemId, score: entry.score };
  if (typeof entry.at === "number" && Number.isFinite(entry.at)) {
    item.at = entry.at;
  }
  return item;
}

function isSimilarItem(entry: unknown): entry is SimilarItem {
  if (entry === null || typeof entry !== "object") {
    return false;
  }
  const candidate = entry as Record<string, unknown>;
  return typeof candidate.itemId === "string" && typeof candidate.score === "number" && Number.isFinite(candidate.score);
}
