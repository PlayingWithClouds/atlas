import fs from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { makeTempDirectory, startHost, urlOf, writeAtlasConfig } from "./helpers";

const PLUGIN_SOURCE = `
export default {
  name: "temp-plugin",
  inject: ["http"],
  apply(ctx, config) {
    globalThis.tempPluginTicks = globalThis.tempPluginTicks || { count: 0, running: 0, configs: [] };
    const ticks = globalThis.tempPluginTicks;
    ticks.configs.push(config);
    ctx.effect(() => ctx.http.route("GET", "/api/temp", () => ({ config })), "route:temp");
    ctx.effect(() => {
      ticks.running += 1;
      const handle = setInterval(() => { ticks.count += 1; }, 5);
      return () => { clearInterval(handle); ticks.running -= 1; };
    }, "interval:temp");
  },
};
`;

function writeTempPlugin(workspaceDirectory: string): void {
  const pluginDirectory = path.join(workspaceDirectory, "plugins", "temp");
  fs.mkdirSync(pluginDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDirectory, "package.json"),
    JSON.stringify({ name: "temp-plugin", atlas: { server: "./server.js" } }),
  );
  fs.writeFileSync(path.join(pluginDirectory, "server.js"), PLUGIN_SOURCE);
}

function configWith(plugins: unknown[]) {
  return { title: "t", plugins, workflows: [], settings: {} };
}

const entry = (config: Record<string, unknown>) => ({ package: "temp-plugin", path: "plugins/temp", config });

test("plugin loads, unloads, reloads and updates live", async () => {
  const workspaceDirectory = makeTempDirectory();
  writeTempPlugin(workspaceDirectory);
  writeAtlasConfig(workspaceDirectory, configWith([entry({ a: 1 })]));
  delete (globalThis as any).tempPluginTicks;
  const host = await startHost(workspaceDirectory);
  const ticks = (globalThis as any).tempPluginTicks;
  const base = 0;

  expect(await (await fetch(urlOf(host, "/api/temp"))).json()).toEqual({ config: { a: 1 } });
  expect(ticks.running).toBe(base + 1);
  const listed = await (await fetch(urlOf(host, "/api/plugins"))).json();
  expect(listed[0]).toMatchObject({ name: "temp-plugin", state: "ACTIVE" });
  expect(listed[0].contributions).toContain("route:temp");

  writeAtlasConfig(workspaceDirectory, configWith([]));
  await host.context.plugins.reload();
  expect((await fetch(urlOf(host, "/api/temp"))).status).toBe(404);
  expect(ticks.running).toBe(base);

  writeAtlasConfig(workspaceDirectory, configWith([entry({ a: 2 })]));
  await host.context.plugins.reload();
  expect(await (await fetch(urlOf(host, "/api/temp"))).json()).toEqual({ config: { a: 2 } });

  writeAtlasConfig(workspaceDirectory, configWith([entry({ a: 3 })]));
  await host.context.plugins.reload();
  expect(await (await fetch(urlOf(host, "/api/temp"))).json()).toEqual({ config: { a: 3 } });
  expect(ticks.running).toBe(base + 1);

  await host.stop();
  expect(ticks.running).toBe(base);
});

test("saveConfig triggers an automatic reload", async () => {
  const workspaceDirectory = makeTempDirectory();
  writeTempPlugin(workspaceDirectory);
  const host = await startHost(workspaceDirectory);
  expect((await fetch(urlOf(host, "/api/temp"))).status).toBe(404);
  host.context.workspace.saveConfig(configWith([entry({})]) as any);
  await Bun.sleep(200);
  expect((await fetch(urlOf(host, "/api/temp"))).status).toBe(200);
  await host.stop();
});

test("a broken plugin is reported, not fatal", async () => {
  const workspaceDirectory = makeTempDirectory();
  writeAtlasConfig(workspaceDirectory, configWith([{ package: "missing", path: "nope" }]));
  const host = await startHost(workspaceDirectory);
  const [view] = host.context.plugins.list();
  expect(view.state).toBe("FAILED");
  expect(view.error).toBeTruthy();
  await host.stop();
});
