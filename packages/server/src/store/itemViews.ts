import type { Database } from "bun:sqlite";
import type { Item, ItemPage, ItemStatus, ItemView, QueueNext } from "@atlas/contracts";

interface ViewRow {
  sequence: number;
  sort_start: number;
  item: string;
  asset: string;
  annotation: string | null;
  priority: number | null;
}

export interface PageRequest {
  status?: ItemStatus;
  /** Sequence of the last item of the previous page. */
  after: number;
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
  return view;
}

function statusCondition(status: ItemStatus | undefined): string {
  if (status === undefined) {
    return "";
  }
  if (status === "pending") {
    return "AND annotations.item_id IS NULL";
  }
  return `AND annotations.status = '${status}'`;
}

/** Read side of the store: items joined with their asset, annotation and best suggestion priority. */
export class ItemViews {
  constructor(private readonly database: Database) {}

  page(projectId: string, request: PageRequest): ItemPage {
    const rows = this.database
      .query(
        `${VIEW_SELECT} WHERE items.project_id = ? AND items.sequence > ? ${statusCondition(request.status)}
         ORDER BY items.sequence LIMIT ?`,
      )
      .all(projectId, request.after, request.limit + 1) as ViewRow[];
    const pageRows = rows.slice(0, request.limit);
    const page: ItemPage = { items: pageRows.map(viewOf) };
    if (rows.length > request.limit) {
      page.cursor = String(pageRows[pageRows.length - 1].sequence);
    }
    return page;
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
  queueNext(projectId: string, after: string | undefined): QueueNext {
    const rows = this.database
      .query(
        `${VIEW_SELECT}
         WHERE items.project_id = ? AND annotations.item_id IS NULL AND items.id != ?
         ORDER BY priority IS NULL, priority DESC, items.sequence LIMIT 1`,
      )
      .all(projectId, excludedItemId(after)) as ViewRow[];
    const pending = this.countPending(projectId);
    if (rows.length === 0) {
      return { pending };
    }
    return { item: viewOf(rows[0]), pending };
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
