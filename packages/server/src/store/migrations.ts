import type { Migration } from "@atlas/contracts/server";

export const STORE_NAMESPACE = "store";

/** JSON columns hold the record exactly as pushed; columns beside them exist for queries only. */
const INITIAL_SCHEMA = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    taxonomy_groups TEXT NOT NULL,
    taxonomy_version INTEGER NOT NULL,
    prefill_source TEXT,
    created TEXT NOT NULL
  );

  CREATE TABLE assets (
    project_id TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (project_id, id)
  );

  CREATE TABLE items (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    sort_start REAL NOT NULL,
    data TEXT NOT NULL,
    UNIQUE (project_id, id)
  );
  CREATE INDEX items_by_asset ON items (project_id, asset_id, sort_start, sequence);

  CREATE TABLE annotations (
    project_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (project_id, item_id)
  );

  CREATE TABLE suggestions (
    project_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    source TEXT NOT NULL,
    priority REAL,
    data TEXT NOT NULL,
    pushed REAL NOT NULL DEFAULT (unixepoch('subsec')),
    PRIMARY KEY (project_id, item_id, source)
  );

  CREATE TABLE changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    annotation TEXT
  );
  CREATE INDEX changes_by_project ON changes (project_id, id);
`;

export const STORE_MIGRATIONS: Migration[] = [{ version: 1, sql: INITIAL_SCHEMA }];
