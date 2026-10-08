import { afterEach, describe, expect, test } from "bun:test";
import { HttpError } from "../../packages/contracts/src/server";
import { matchSegments, splitPath } from "../../packages/server/src/services/router";
import type { Host } from "../../packages/server/src/index";
import { startHost, urlOf } from "./helpers";

describe("router matching", () => {
  test("params and wildcard", () => {
    expect(matchSegments(splitPath("/api/items/:id"), splitPath("/api/items/a%20b"))).toEqual({ id: "a b" });
    expect(matchSegments(splitPath("/files/*"), splitPath("/files/x/y.png"))).toEqual({ "*": "x/y.png" });
    expect(matchSegments(splitPath("/api/items/:id"), splitPath("/api/items"))).toBeUndefined();
    expect(matchSegments(splitPath("/api/items"), splitPath("/api/items/1"))).toBeUndefined();
  });
});

describe("http service", () => {
  let host: Host;
  afterEach(async () => {
    await host.stop();
  });

  test("health, json, 204, errors, cors", async () => {
    host = await startHost();
    const http = host.context.http;
    http.route("GET", "/t/json/:name", (_request, params) => ({ name: params.name }));
    http.route("GET", "/t/empty", () => undefined);
    http.route("GET", "/t/response", () => new Response("raw", { status: 201 }));
    http.route("GET", "/t/http-error", () => {
      throw new HttpError(418, "teapot");
    });
    http.route("GET", "/t/crash", () => {
      throw new Error("boom");
    });

    expect(await (await fetch(urlOf(host, "/api/health"))).json()).toEqual({ ok: true });
    expect(await (await fetch(urlOf(host, "/t/json/x"))).json()).toEqual({ name: "x" });
    expect((await fetch(urlOf(host, "/t/empty"))).status).toBe(204);

    const raw = await fetch(urlOf(host, "/t/response"));
    expect(raw.status).toBe(201);
    expect(await raw.text()).toBe("raw");
    expect(raw.headers.get("access-control-allow-origin")).toBe("*");

    const teapot = await fetch(urlOf(host, "/t/http-error"));
    expect(teapot.status).toBe(418);
    expect(await teapot.json()).toEqual({ detail: "teapot" });

    const crash = await fetch(urlOf(host, "/t/crash"));
    expect(crash.status).toBe(500);
    expect(await crash.json()).toEqual({ detail: "boom" });

    const preflight = await fetch(urlOf(host, "/anything"), { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
  });

  test("route disposer removes the route", async () => {
    host = await startHost();
    const dispose = host.context.http.route("GET", "/t/temp", () => ({ ok: 1 }));
    expect((await fetch(urlOf(host, "/t/temp"))).status).toBe(200);
    dispose();
    expect((await fetch(urlOf(host, "/t/temp"))).status).toBe(404);
  });

  test("websocket receives state snapshot and toast", async () => {
    host = await startHost();
    host.context.live.provideState("probe", () => 42);
    const socket = new WebSocket(`ws://localhost:${host.context.http.port}/api/ws`);
    const messages: any[] = [];
    socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
    await new Promise((resolve) => (socket.onopen = resolve));
    await Bun.sleep(50);
    expect(messages[0].type).toBe("state");
    expect(messages[0].probe).toBe(42);
    host.context.notifications.toast({ message: "hi" });
    await Bun.sleep(50);
    const toast = messages.find((message) => message.type === "toast");
    expect(toast.toast.message).toBe("hi");
    socket.close();
  });
});
