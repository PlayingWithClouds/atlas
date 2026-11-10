import type { Database } from "bun:sqlite";
import type { Annotation, Change, ChangeKind, Feed } from "@atlas/contracts";

interface DataRow {
  data: string;
}

interface ChangeRow {
  id: number;
  item_id: string;
  kind: ChangeKind;
  annotation: string | null;
}

export const MAXIMUM_FEED_LIMIT = 1000;
export const DEFAULT_FEED_LIMIT = 100;

function changeOf(row: ChangeRow): Change {
  const change: Change = { cursor: String(row.id), itemId: row.item_id, kind: row.kind };
  if (row.annotation !== null) {
    change.annotation = JSON.parse(row.annotation);
  }
  return change;
}

export class AnnotationsTable {
  constructor(private readonly database: Database) {}

  get(projectId: string, itemId: string): Annotation | undefined {
    const row = this.database
      .query("SELECT data FROM annotations WHERE project_id = ? AND item_id = ?")
      .get(projectId, itemId) as DataRow | null;
    if (row === null) {
      return undefined;
    }
    return JSON.parse(row.data);
  }

  upsert(projectId: string, annotation: Annotation): void {
    this.database
      .query(
        `INSERT INTO annotations (project_id, item_id, status, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (project_id, item_id) DO UPDATE SET status = excluded.status, data = excluded.data`,
      )
      .run(projectId, annotation.itemId, annotation.status, JSON.stringify(annotation));
  }

  delete(projectId: string, itemId: string): void {
    this.database.query("DELETE FROM annotations WHERE project_id = ? AND item_id = ?").run(projectId, itemId);
  }

  /** Appends to the change log; the new row's id is the feed cursor. */
  logChange(projectId: string, itemId: string, kind: ChangeKind, annotation: Annotation | undefined): Change {
    const serialized = this.serialize(annotation);
    const result = this.database
      .query("INSERT INTO changes (project_id, item_id, kind, annotation) VALUES (?, ?, ?, ?)")
      .run(projectId, itemId, kind, serialized);
    const change: Change = { cursor: String(result.lastInsertRowid), itemId, kind };
    if (annotation !== undefined) {
      change.annotation = annotation;
    }
    return change;
  }

  feed(projectId: string, since: number, limit: number): Feed {
    const rows = this.database
      .query("SELECT * FROM changes WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(projectId, since, limit) as ChangeRow[];
    const changes = rows.map(changeOf);
    if (changes.length === 0) {
      return { changes, cursor: String(since) };
    }
    return { changes, cursor: changes[changes.length - 1].cursor };
  }

  private serialize(annotation: Annotation | undefined): string | null {
    if (annotation === undefined) {
      return null;
    }
    return JSON.stringify(annotation);
  }
}
