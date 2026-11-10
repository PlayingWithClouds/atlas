import type { Database } from "bun:sqlite";
import type { Asset, Item } from "@atlas/contracts";

interface DataRow {
  data: string;
}

function sortStartOf(item: Item): number {
  if (item.span === undefined) {
    return 0;
  }
  return item.span.start;
}

export class MediaTable {
  constructor(private readonly database: Database) {}

  getAsset(projectId: string, assetId: string): Asset | undefined {
    const row = this.database
      .query("SELECT data FROM assets WHERE project_id = ? AND id = ?")
      .get(projectId, assetId) as DataRow | null;
    if (row === null) {
      return undefined;
    }
    return JSON.parse(row.data);
  }

  upsertAsset(projectId: string, asset: Asset): void {
    this.database
      .query(
        `INSERT INTO assets (project_id, id, data) VALUES (?, ?, ?)
         ON CONFLICT (project_id, id) DO UPDATE SET data = excluded.data`,
      )
      .run(projectId, asset.id, JSON.stringify(asset));
  }

  getItem(projectId: string, itemId: string): Item | undefined {
    const row = this.database
      .query("SELECT data FROM items WHERE project_id = ? AND id = ?")
      .get(projectId, itemId) as DataRow | null;
    if (row === null) {
      return undefined;
    }
    return JSON.parse(row.data);
  }

  /** An existing item keeps its place in push order. */
  upsertItem(projectId: string, item: Item): void {
    this.database
      .query(
        `INSERT INTO items (project_id, id, asset_id, sort_start, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, id) DO UPDATE SET
           asset_id = excluded.asset_id, sort_start = excluded.sort_start, data = excluded.data`,
      )
      .run(projectId, item.id, item.assetId, sortStartOf(item), JSON.stringify(item));
  }

  deleteItem(projectId: string, itemId: string): boolean {
    const result = this.database.query("DELETE FROM items WHERE project_id = ? AND id = ?").run(projectId, itemId);
    return result.changes > 0;
  }
}
