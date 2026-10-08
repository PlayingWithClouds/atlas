import fs from "node:fs";
import path from "node:path";
import { HttpError } from "@atlas/contracts/server";
import type { DbService } from "@atlas/contracts/server";

const ROOTS_MIGRATION = `CREATE TABLE imported_roots (path TEXT PRIMARY KEY);`;

/** Folders the import source has resolved; only files inside them may be located. */
export class ImportedRoots {
  constructor(private readonly db: DbService) {
    db.migrate("exporter-folder", [{ version: 1, sql: ROOTS_MIGRATION }]);
  }

  grant(directory: string): void {
    const root = fs.realpathSync(directory);
    this.db.database.query("INSERT OR IGNORE INTO imported_roots (path) VALUES (?)").run(root);
  }

  authorize(filePath: string): string {
    let resolved: string;
    try {
      resolved = fs.realpathSync(filePath);
    } catch (error) {
      throw new HttpError(404, "file not found");
    }
    if (!this.isInsideGrantedRoot(resolved)) {
      throw new HttpError(403, "path is outside every imported folder");
    }
    return resolved;
  }

  private isInsideGrantedRoot(resolved: string): boolean {
    const rows = this.db.database.query("SELECT path FROM imported_roots").all() as { path: string }[];
    return rows.some((row) => {
      const relative = path.relative(row.path, resolved);
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    });
  }
}
