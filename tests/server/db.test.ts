import { afterEach, expect, test } from "bun:test";
import type { Host } from "../../packages/server/src/index";
import { startHost } from "./helpers";

let host: Host;
afterEach(async () => {
  await host.stop();
});

test("migrate is idempotent, ordered and namespaced", async () => {
  host = await startHost();
  const db = host.context.db;
  const migrations = [
    { version: 2, sql: "INSERT INTO t_a (value) VALUES ('second')" },
    { version: 1, sql: "CREATE TABLE t_a (value TEXT)" },
  ];
  db.migrate("a", migrations);
  db.migrate("a", migrations);
  const rows = db.database.query("SELECT rowid, value FROM t_a").all();
  expect(rows).toHaveLength(1);

  db.migrate("b", [{ version: 1, sql: "CREATE TABLE t_b (value TEXT)" }]);
  const applied = db.database.query("SELECT namespace, version FROM _migrations WHERE namespace IN ('a','b') ORDER BY namespace, version").all();
  expect(applied).toEqual([
    { namespace: "a", version: 1 },
    { namespace: "a", version: 2 },
    { namespace: "b", version: 1 },
  ]);
});

test("a failing migration rolls back entirely", async () => {
  host = await startHost();
  const db = host.context.db;
  expect(() =>
    db.migrate("broken", [
      { version: 1, sql: "CREATE TABLE t_broken (value TEXT)" },
      { version: 2, sql: "THIS IS NOT SQL" },
    ]),
  ).toThrow();
  const applied = db.database.query("SELECT * FROM _migrations WHERE namespace = 'broken'").all();
  expect(applied).toHaveLength(0);
});
