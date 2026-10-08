import fs from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { makeTempDirectory, startHost } from "./helpers";

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
  fs.writeFileSync(configPath, JSON.stringify({ title: "mine", plugins: [], workflows: [], settings: {} }));
  const second = await startHost(workspaceDirectory);
  expect(second.context.workspace.config().title).toBe("mine");
  await second.stop();
});
