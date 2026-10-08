import fs from "node:fs";
import path from "node:path";
import type { DbService } from "@atlas/contracts/server";
import { HttpError } from "@atlas/contracts/server";
import { isInside } from "./scan";

export const NAMESPACE = "source-fs";

/** Remembers which paths this source handed out so `locate` cannot be pointed elsewhere. */
export class AllowedRoots {
  constructor(
    private readonly db: DbService,
    private readonly configuredRoots: string[],
  ) {
    db.migrate(NAMESPACE, [
      { version: 1, sql: "CREATE TABLE allowed_roots (path TEXT PRIMARY KEY, created INTEGER NOT NULL)" },
    ]);
  }

  grant(rootPath: string): void {
    this.db.database
      .query("INSERT OR IGNORE INTO allowed_roots (path, created) VALUES (?, ?)")
      .run(rootPath, Date.now());
  }

  private roots(): string[] {
    const rows = this.db.database.query("SELECT path FROM allowed_roots").all() as { path: string }[];
    return [...this.configuredRoots, ...rows.map((row) => row.path)];
  }

  /** Returns the real path of `ref`, or throws 403 when it escapes every allowed root. */
  authorize(ref: string): string {
    if (!path.isAbsolute(ref)) {
      throw new HttpError(403, "path is not allowed");
    }
    const resolved = this.realPathOf(ref);
    const allowed = this.roots().some((root) => isInside(this.realPathOrSelf(root), resolved));
    if (!allowed) {
      throw new HttpError(403, "path is not inside an allowed root");
    }
    return resolved;
  }

  private realPathOf(ref: string): string {
    try {
      return fs.realpathSync(ref);
    } catch (error) {
      throw new HttpError(404, "file not found");
    }
  }

  private realPathOrSelf(root: string): string {
    try {
      return fs.realpathSync(root);
    } catch (error) {
      return path.resolve(root);
    }
  }
}
