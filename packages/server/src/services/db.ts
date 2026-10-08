import path from "node:path";
import { Database } from "bun:sqlite";
import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import type { DbService, Migration } from "@atlas/contracts/server";

export class DbCore extends Service implements DbService {
  static inject = ["workspace"];

  readonly database: Database;

  constructor(ctx: Context) {
    super(ctx, "db");
    this.database = new Database(path.join(ctx.workspace.directory, "atlas.db"), { create: true });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (namespace TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (namespace, version))",
    );
    this.ctx.effect(() => () => this.database.close(), "db:close");
  }

  migrate(namespace: string, migrations: Migration[]): void {
    const applied = this.appliedVersions(namespace);
    const pending = migrations
      .filter((migration) => !applied.has(migration.version))
      .sort((first, second) => first.version - second.version);
    if (pending.length === 0) {
      return;
    }
    this.transaction(() => {
      for (const migration of pending) {
        this.applyMigration(namespace, migration);
      }
    });
  }

  transaction<T>(run: () => T): T {
    return this.database.transaction(run)();
  }

  private appliedVersions(namespace: string): Set<number> {
    const rows = this.database
      .query("SELECT version FROM _migrations WHERE namespace = ?")
      .all(namespace) as { version: number }[];
    return new Set(rows.map((row) => row.version));
  }

  private applyMigration(namespace: string, migration: Migration): void {
    this.database.exec(migration.sql);
    this.database
      .query("INSERT INTO _migrations (namespace, version) VALUES (?, ?)")
      .run(namespace, migration.version);
  }
}

export default DbCore;
