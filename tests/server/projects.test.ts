import { expect, test } from "bun:test";
import { HttpError } from "../../packages/contracts/src/server";
import { projectConfig } from "./fakes";
import { startHost, urlOf } from "./helpers";

test("slug collisions get numeric suffixes", async () => {
  const host = await startHost();
  const first = host.context.projects.create("My Project", projectConfig());
  const second = host.context.projects.create("My Project", projectConfig());
  const third = host.context.projects.create("My Project!", projectConfig());
  expect([first.id, second.id, third.id]).toEqual(["my-project", "my-project-2", "my-project-3"]);
  await host.stop();
});

test("invalid configs are rejected with 400", async () => {
  const host = await startHost();
  const broken = [
    { ...projectConfig(), mediaKind: undefined },
    { ...projectConfig(), model: undefined },
    { ...projectConfig(), primitives: undefined },
    { ...projectConfig(), labels: {} },
  ];
  for (const config of broken) {
    expect(() => host.context.projects.create("p", config as never)).toThrow(HttpError);
    const response = await fetch(urlOf(host, "/api/projects"), {
      method: "POST",
      body: JSON.stringify({ name: "p", config }),
    });
    expect(response.status).toBe(400);
  }
  await host.stop();
});

test("update merges config keys and emits project/changed", async () => {
  const host = await startHost();
  const events: string[] = [];
  host.context.on("project/changed", (project) => {
    events.push(project.id);
  });
  const project = host.context.projects.create("p", projectConfig());
  const updated = host.context.projects.update(project.id, { config: { model: "other" } });
  expect(updated.config.model).toBe("other");
  expect(updated.config.mediaKind).toBe("fake-media");
  expect(events).toEqual(["p", "p"]);
  await host.stop();
});

test("remove cascades to sessions and items", async () => {
  const host = await startHost();
  const { projects, items } = host.context;
  const project = projects.create("p", projectConfig());
  const session = items.createSession({ projectId: project.id, label: "s", source: { plugin: "x", kind: "k", params: {} } });
  items.append(session.id, [{ ref: "a", mediaKind: "fake-media" }]);
  projects.remove(project.id);
  expect(items.getSession(session.id)).toBeUndefined();
  const count = host.context.db.database.query("SELECT COUNT(*) AS n FROM items").get() as { n: number };
  expect(count.n).toBe(0);
  await host.stop();
});
