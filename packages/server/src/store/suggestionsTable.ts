import type { Database } from "bun:sqlite";
import type { Suggestion } from "@atlas/contracts";

interface DataRow {
  data: string;
}

function priorityColumn(suggestion: Suggestion): number | null {
  if (suggestion.priority === undefined) {
    return null;
  }
  return suggestion.priority;
}

export class SuggestionsTable {
  constructor(private readonly database: Database) {}

  /** The latest push per (item, source) replaces the previous one. */
  upsert(projectId: string, suggestion: Suggestion): void {
    this.database
      .query(
        `INSERT INTO suggestions (project_id, item_id, source, priority, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, item_id, source)
         DO UPDATE SET priority = excluded.priority, data = excluded.data, pushed = unixepoch('subsec')`,
      )
      .run(projectId, suggestion.itemId, suggestion.source, priorityColumn(suggestion), JSON.stringify(suggestion));
  }

  /** Oldest push first, so the newest source is last. */
  forItem(projectId: string, itemId: string): Suggestion[] {
    const rows = this.database
      .query("SELECT data FROM suggestions WHERE project_id = ? AND item_id = ? ORDER BY pushed, source")
      .all(projectId, itemId) as DataRow[];
    return rows.map((row) => JSON.parse(row.data));
  }

  /** Source of the most recent push that carried values, i.e. the model's current output. */
  latestValueSource(projectId: string): string | undefined {
    const row = this.database
      .query(
        `SELECT source FROM suggestions WHERE project_id = ? AND json_type(data, '$.values') IS NOT NULL
         ORDER BY pushed DESC LIMIT 1`,
      )
      .get(projectId) as { source: string } | null;
    if (row === null) {
      return undefined;
    }
    return row.source;
  }

  deleteForItem(projectId: string, itemId: string): void {
    this.database.query("DELETE FROM suggestions WHERE project_id = ? AND item_id = ?").run(projectId, itemId);
  }
}
