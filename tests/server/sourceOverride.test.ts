import { expect, test } from "bun:test";
import { fakeSource, mountProviders, projectConfig } from "./fakes";
import { startHost } from "./helpers";
import type { SourceProvider } from "../../packages/contracts/src/server";

function overrideSource(): SourceProvider {
  return {
    id: "override-source",
    kinds: () => [],
    resolve: async () => ({ label: "unused", items: [] }),
    locate: (ref) => ({ kind: "file", path: `/override/${ref}` }),
  };
}

test("locate uses meta.source over the session's provider", async () => {
  const host = await startHost();
  await mountProviders(host, { source: fakeSource(1) });
  host.context.sources.register(overrideSource());
  const project = host.context.projects.create("p", projectConfig());
  const session = host.context.items.createSession({
    projectId: project.id,
    label: "s",
    source: { plugin: "fake-source", kind: "list", params: {} },
  });
  const [plainItem, overriddenItem] = host.context.items.append(session.id, [
    { ref: "plain", mediaKind: "image" },
    { ref: "frame", mediaKind: "image", meta: { source: "override-source" } },
  ]);

  const overriddenLocation = await host.context.sources.locate(overriddenItem);
  expect(overriddenLocation).toEqual({ kind: "file", path: "/override/frame" });

  const plainLocation = await host.context.sources.locate(plainItem);
  expect(plainLocation).not.toEqual({ kind: "file", path: "/override/plain" });
  await host.stop();
});
