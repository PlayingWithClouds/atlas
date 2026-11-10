import fs from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { makeTempDirectory, startHost, urlOf } from "./helpers";

test("stop closes the port and the database", async () => {
  const workspaceDirectory = makeTempDirectory();
  const host = await startHost(workspaceDirectory);
  const port = host.context.http.port;
  const database = host.context.db.database;
  expect((await fetch(`http://localhost:${port}/api/health`)).status).toBe(200);
  await host.stop();

  await expect(fetch(`http://localhost:${port}/api/health`)).rejects.toThrow();
  expect(() => database.query("SELECT 1").get()).toThrow();
});

test("starter atlas.json is created once and never overwritten", async () => {
  const workspaceDirectory = makeTempDirectory();
  const first = await startHost(workspaceDirectory);
  await first.stop();
  const configPath = path.join(workspaceDirectory, "atlas.json");
  expect(JSON.parse(fs.readFileSync(configPath, "utf8")).title).toBe("atlas");
  fs.writeFileSync(configPath, JSON.stringify({ title: "mine", plugins: [], webhooks: [], tokens: [], settings: {} }));
  const second = await startHost(workspaceDirectory);
  expect(second.context.workspace.config().title).toBe("mine");
  await second.stop();
});

test("the store lives in store.db and an old atlas.db is never opened", async () => {
  const workspaceDirectory = makeTempDirectory();
  const oldDatabasePath = path.join(workspaceDirectory, "atlas.db");
  fs.writeFileSync(oldDatabasePath, "legacy bytes, not a database");
  const host = await startHost(workspaceDirectory);
  await host.stop();
  expect(fs.existsSync(path.join(workspaceDirectory, "store.db"))).toBe(true);
  expect(fs.readFileSync(oldDatabasePath, "utf8")).toBe("legacy bytes, not a database");
});

test("the store survives a restart", async () => {
  const workspaceDirectory = makeTempDirectory();
  const first = await startHost(workspaceDirectory);
  await fetch(urlOf(first, "/api/projects"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "kept", name: "Kept" }),
  });
  await first.stop();
  const second = await startHost(workspaceDirectory);
  const projects = await (await fetch(urlOf(second, "/api/projects"))).json();
  expect(projects.map((project: { id: string }) => project.id)).toEqual(["kept"]);
  await second.stop();
});
