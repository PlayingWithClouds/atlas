import { afterEach, describe, expect, test } from "bun:test";
import { isAuthorized, isLoopbackAddress } from "../../packages/server/src/services/auth";
import type { HttpCore } from "../../packages/server/src/index";
import type { Host } from "../../packages/server/src/index";
import { makeTempDirectory, startHost, writeAtlasConfig } from "./helpers";

const REMOTE = "203.0.113.7";

function request(pathname: string, headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(`http://atlas.test${pathname}`, { method, headers });
}

describe("loopback detection", () => {
  test("recognizes IPv4, IPv6 and mapped loopback addresses only", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.3.4.5")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.5")).toBe(false);
    expect(isLoopbackAddress(REMOTE)).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("isAuthorized", () => {
  const tokens = [{ name: "trainer", token: "s3cret" }];

  test("everyone is allowed while no token is configured", () => {
    expect(isAuthorized(request("/api/projects"), REMOTE, [])).toBe(true);
  });

  test("loopback is trusted, other machines need a bearer token", () => {
    expect(isAuthorized(request("/api/projects"), "127.0.0.1", tokens)).toBe(true);
    expect(isAuthorized(request("/api/projects"), REMOTE, tokens)).toBe(false);
    expect(isAuthorized(request("/api/projects", { authorization: "Bearer wrong" }), REMOTE, tokens)).toBe(false);
    expect(isAuthorized(request("/api/projects", { authorization: "Bearer s3cret" }), REMOTE, tokens)).toBe(true);
    expect(isAuthorized(request("/api/projects", { authorization: "s3cret" }), REMOTE, tokens)).toBe(false);
  });

  test("only the live socket accepts the token as a query parameter", () => {
    expect(isAuthorized(request("/api/live?token=s3cret"), REMOTE, tokens)).toBe(true);
    expect(isAuthorized(request("/api/projects?token=s3cret"), REMOTE, tokens)).toBe(false);
  });
});

describe("the http service", () => {
  let host: Host;
  afterEach(async () => {
    await host.stop();
  });

  async function startWithTokens(tokens: unknown[]): Promise<HttpCore> {
    const workspaceDirectory = makeTempDirectory();
    writeAtlasConfig(workspaceDirectory, { title: "t", plugins: [], webhooks: [], tokens, settings: {} });
    host = await startHost(workspaceDirectory);
    return host.context.http as unknown as HttpCore;
  }

  test("non-loopback callers get 401 on the API but may read health", async () => {
    const http = await startWithTokens([{ name: "trainer", token: "s3cret" }]);
    const denied = await http.respond(request("/api/projects"), REMOTE);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe("Bearer");
    expect((await http.respond(request("/api/health"), REMOTE)).status).toBe(200);
    expect((await http.respond(request("/api/projects", {}, "POST"), REMOTE)).status).toBe(401);
  });

  test("a valid token opens the API to other machines", async () => {
    const http = await startWithTokens([{ name: "trainer", token: "s3cret" }]);
    const allowed = await http.respond(request("/api/projects", { authorization: "Bearer s3cret" }), REMOTE);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual([]);
  });

  test("real loopback requests need no token even when tokens exist", async () => {
    await startWithTokens([{ name: "trainer", token: "s3cret" }]);
    const response = await fetch(`http://127.0.0.1:${host.context.http.port}/api/projects`);
    expect(response.status).toBe(200);
  });

  test("without configured tokens other machines are allowed", async () => {
    const http = await startWithTokens([]);
    expect((await http.respond(request("/api/projects"), REMOTE)).status).toBe(200);
  });

  test("tokens added to atlas.json apply to the next request", async () => {
    const http = await startWithTokens([]);
    expect((await http.respond(request("/api/projects"), REMOTE)).status).toBe(200);
    host.context.workspace.saveConfig({ title: "t", plugins: [], webhooks: [], tokens: [{ name: "x", token: "abc" }], settings: {} });
    expect((await http.respond(request("/api/projects"), REMOTE)).status).toBe(401);
  });

  test("preflight requests are never blocked", async () => {
    const http = await startWithTokens([{ name: "trainer", token: "s3cret" }]);
    const preflight = await http.respond(request("/api/projects", {}, "OPTIONS"), REMOTE);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
  });
});
