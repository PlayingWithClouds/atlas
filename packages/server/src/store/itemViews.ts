import type { Database } from "bun:sqlite";
import type { Item, ItemPage, ItemStatus, ItemView, QueueNext } from "@atlas/contracts";
import { filterConditions, matchExpression, modelJoin, orderTerms } from "./itemFilter";
import type { ItemFilter } from "./itemFilter";

interface ViewRow {
  sequence: number;
  sort_start: number;
  item: string;
  asset: string;
  annotation: string | null;
  priority: number | null;
  match?: number | null;
}

export interface PageRequest {
  filter: ItemFilter;
  /** Push order: sequence of the last item of the previous page. Other sorts: rows to skip. */
  cursor: number;
  limit: number;
}

const VIEW_SELECT = `
  SELECT
    items.sequence AS sequence,
    items.sort_start AS sort_start,
    items.data AS item,
    assets.data AS asset,
    annotations.data AS annotation,
    (SELECT MAX(suggestions.priority) FROM suggestions
       WHERE suggestions.project_id = items.project_id AND suggestions.item_id = items.id) AS priority
  FROM items
  JOIN assets ON assets.project_id = items.project_id AND assets.id = items.asset_id
  LEFT JOIN annotations ON annotations.project_id = items.project_id AND annotations.item_id = items.id
`;

function statusOf(row: ViewRow): ItemStatus {
  if (row.annotation === null) {
    return "pending";
  }
  return JSON.parse(row.annotation).status;
}

function viewOf(row: ViewRow): ItemView {
  const view: ItemView = {
    item: JSON.parse(row.item),
    asset: JSON.parse(row.asset),
    status: statusOf(row),
  };
  if (row.priority !== null) {
    view.priority = row.priority;
  }
  if (row.annotation !== null) {
    view.annotation = JSON.parse(row.annotation);
  }
  if (row.match !== undefined && row.match !== null) {
    view.match = row.match;
  }
  return view;
}

const FILTERED_SELECT = `
  SELECT
    items.sequence AS sequence,
    items.sort_start AS sort_start,
    items.data AS item,
    assets.data AS asset,
    annotations.data AS annotation,
    (SELECT MAX(suggestions.priority) FROM suggestions
       WHERE suggestions.project_id = items.project_id AND suggestions.item_id = items.id) AS priority,
    MATCH_EXPRESSION AS match
  FROM items
  JOIN assets ON assets.project_id = items.project_id AND assets.id = items.asset_id
  LEFT JOIN annotations ON annotations.project_id = items.project_id AND annotations.item_id = items.id
  MODEL_JOIN
`;

/** Read side of the store: items joined with their asset, annotation and best suggestion priority. */
export class ItemViews {
  constructor(private readonly database: Database) {}

  page(projectId: string, request: PageRequest): ItemPage {
    const rows = this.filteredRows(projectId, request);
    const pageRows = rows.slice(0, request.limit);
    const page: ItemPage = { items: pageRows.map(viewOf) };
    if (rows.length > request.limit) {
      page.cursor = nextCursor(request, pageRows);
    }
    return page;
  }

  /** One row more than the limit, so the caller knows whether a next page exists. */
  private filteredRows(projectId: string, request: PageRequest): ViewRow[] {
    const match = matchExpression(request.filter);
    const join = modelJoin(request.filter);
    const conditions = filterConditions(request.filter);
    const select = FILTERED_SELECT.replace("MATCH_EXPRESSION", match.sql).replace("MODEL_JOIN", join.sql);
    const params = [...match.params, ...join.params, projectId];
    if (request.filter.sort === "order") {
      return this.database
        .query(`${select} WHERE items.project_id = ? AND items.sequence > ? ${conditions.sql} ORDER BY sequence LIMIT ?`)
        .all(...params, request.cursor, ...conditions.params, request.limit + 1) as ViewRow[];
    }
    return this.database
      .query(`${select} WHERE items.project_id = ? ${conditions.sql} ORDER BY ${orderTerms(request.filter)} LIMIT ? OFFSET ?`)
      .all(...params, ...conditions.params, request.limit + 1, request.cursor) as ViewRow[];
  }

  get(projectId: string, itemId: string): ItemView | undefined {
    const row = this.rowOf(projectId, itemId);
    if (row === undefined) {
      return undefined;
    }
    return viewOf(row);
  }

  /** The neighbours of an item inside its asset, ordered by span start and then push order. */
  neighbours(projectId: string, itemId: string): { previous?: ItemView; next?: ItemView } {
    const row = this.rowOf(projectId, itemId);
    if (row === undefined) {
      return {};
    }
    const assetId = (JSON.parse(row.item) as Item).assetId;
    const neighbours: { previous?: ItemView; next?: ItemView } = {};
    const previous = this.adjacent(projectId, assetId, row, "<", "DESC");
    const next = this.adjacent(projectId, assetId, row, ">", "ASC");
    if (previous !== undefined) {
      neighbours.previous = previous;
    }
    if (next !== undefined) {
      neighbours.next = next;
    }
    return neighbours;
  }

  /** Pending items by highest suggestion priority, items without priority last, then push order. */
  queueNext(projectId: string, after: string | undefined, filter: ItemFilter): QueueNext {
    const pending = this.countPending(projectId);
    const nextId = this.nextPendingId(projectId, excludedItemId(after), filter);
    if (nextId === undefined) {
      return { pending };
    }
    const row = this.rowOf(projectId, nextId);
    if (row === undefined) {
      return { pending };
    }
    return { item: viewOf(row), pending };
  }

  /** Sorts ids only: carrying the JSON columns through the sort made this ~15x slower. */
  private nextPendingId(projectId: string, excludedId: string, filter: ItemFilter): string | undefined {
    const join = modelJoin(filter);
    const conditions = filterConditions({ ...filter, status: "pending" });
    const row = this.database
      .query(
        `WITH best AS (
           SELECT item_id, MAX(priority) AS priority FROM suggestions WHERE project_id = ? GROUP BY item_id
         )
         SELECT items.id AS id FROM items
         JOIN assets ON assets.project_id = items.project_id AND assets.id = items.asset_id
         LEFT JOIN annotations ON annotations.project_id = items.project_id AND annotations.item_id = items.id
         LEFT JOIN best ON best.item_id = items.id
         ${join.sql}
         WHERE items.project_id = ? AND items.id != ? ${conditions.sql}
         ORDER BY best.priority IS NULL, best.priority DESC, items.sequence LIMIT 1`,
      )
      .get(projectId, ...join.params, projectId, excludedId, ...conditions.params) as { id: string } | null;
    if (row === null) {
      return undefined;
    }
    return row.id;
  }

  private countPending(projectId: string): number {
    const row = this.database
      .query(
        `SELECT COUNT(*) AS pending FROM items
         LEFT JOIN annotations ON annotations.project_id = items.project_id AND annotations.item_id = items.id
         WHERE items.project_id = ? AND annotations.item_id IS NULL`,
      )
      .get(projectId) as { pending: number };
    return row.pending;
  }

  private rowOf(projectId: string, itemId: string): ViewRow | undefined {
    const row = this.database
      .query(`${VIEW_SELECT} WHERE items.project_id = ? AND items.id = ?`)
      .get(projectId, itemId) as ViewRow | null;
    if (row === null) {
      return undefined;
    }
    return row;
  }

  private adjacent(
    projectId: string,
    assetId: string,
    from: ViewRow,
    comparison: "<" | ">",
    direction: "ASC" | "DESC",
  ): ItemView | undefined {
    const row = this.database
      .query(
        `${VIEW_SELECT}
         WHERE items.project_id = ? AND items.asset_id = ?
           AND (items.sort_start, items.sequence) ${comparison} (?, ?)
         ORDER BY items.sort_start ${direction}, items.sequence ${direction} LIMIT 1`,
      )
      .get(projectId, assetId, from.sort_start, from.sequence) as ViewRow | null;
    if (row === null) {
      return undefined;
    }
    return viewOf(row);
  }
}

/** An id no item has: lets the same query serve the case without an `after` item. */
function excludedItemId(after: string | undefined): string {
  if (after === undefined) {
    return "";
  }
  return after;
}

function nextCursor(request: PageRequest, pageRows: ViewRow[]): string {
  if (request.filter.sort === "order") {
    return String(pageRows[pageRows.length - 1].sequence);
  }
  return String(request.cursor + pageRows.length);
}
