import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Item } from "@atlas/contracts";
import type { MediaLocation } from "@atlas/contracts/server";
import { proxyUpstream, serveLocalFile, serveWholeVideo } from "../src/delivery";
import { MAX_RANGE_BYTES } from "../src/range";

const BODY = "0123456789";
const REFERER = "https://cdn.example.com/";

let servers: ReturnType<typeof Bun.serve>[] = [];
let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "video-delivery-"));
});

afterEach(() => {
  servers.forEach((server) => server.stop(true));
  servers = [];
  fs.rmSync(directory, { recursive: true, force: true });
});

function serve(handler: (request: Request) => Response): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return server;
}

/** A CDN that only answers when the resolved headers are present, and honours ranges. */
function fakeCdn(): ReturnType<typeof Bun.serve> {
  return serve((request) => {
    if (request.headers.get("referer") !== REFERER) {
      return new Response(null, { status: 403 });
    }
    const headers = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
    if (request.headers.get("range") === "bytes=0-3") {
      return new Response(BODY.slice(0, 4), {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes 0-3/${BODY.length}` },
      });
    }
    return new Response(BODY, { headers });
  });
}

function urlLocation(url: string, headers?: Record<string, string>): Extract<MediaLocation, { kind: "url" }> {
  return { kind: "url", url, headers };
}

const item = { id: "i", sessionId: "s", ref: "v", mediaKind: "video", meta: {} } as unknown as Item;

test("proxy forwards location headers and ranges, and copies seeking headers back", async () => {
  const cdn = fakeCdn();
  const request = new Request("http://x/media", { headers: { Range: "bytes=0-3" } });
  const outcome = await proxyUpstream(urlLocation(`http://localhost:${cdn.port}/v`, { Referer: REFERER }), request);
  if (outcome.kind !== "response") {
    throw new Error("expected a response");
  }
  expect(outcome.response.status).toBe(206);
  expect(await outcome.response.text()).toBe("0123");
  expect(outcome.response.headers.get("content-range")).toBe(`bytes 0-3/${BODY.length}`);
  expect(outcome.response.headers.get("accept-ranges")).toBe("bytes");
  expect(outcome.ignoredRange).toBe(false);
});

test("proxy re-applies location headers on every redirect hop, across hosts", async () => {
  const cdn = fakeCdn();
  const redirector = serve(() => new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${cdn.port}/v` } }));
  const request = new Request("http://x/media");
  const outcome = await proxyUpstream(urlLocation(`http://localhost:${redirector.port}/r`, { Referer: REFERER }), request);
  if (outcome.kind !== "response") {
    throw new Error("expected a response");
  }
  expect(outcome.response.status).toBe(200);
  expect(await outcome.response.text()).toBe(BODY);
});

test("proxy bounds an open-ended range sent upstream", async () => {
  let seenRange = "";
  const upstream = serve((request) => {
    seenRange = request.headers.get("range") || "";
    return new Response(BODY, { status: 206 });
  });
  const request = new Request("http://x/media", { headers: { Range: "bytes=0-" } });
  await proxyUpstream(urlLocation(`http://localhost:${upstream.port}/v`), request);
  expect(seenRange).toBe(`bytes=0-${MAX_RANGE_BYTES - 1}`);
});

test("proxy reports a stale status without a response", async () => {
  const upstream = serve(() => new Response(null, { status: 403 }));
  const outcome = await proxyUpstream(urlLocation(`http://localhost:${upstream.port}/v`), new Request("http://x/media"));
  expect(outcome).toEqual({ kind: "stale", status: 403 });
});

test("proxy flags an upstream that ignores Range", async () => {
  const upstream = serve(() => new Response(BODY, { status: 200 }));
  const request = new Request("http://x/media", { headers: { Range: "bytes=0-3" } });
  const outcome = await proxyUpstream(urlLocation(`http://localhost:${upstream.port}/v`), request);
  expect(outcome.kind === "response" && outcome.ignoredRange).toBe(true);
});

test("a stale stream is re-located and retried exactly once", async () => {
  const expired = serve(() => new Response(null, { status: 403 }));
  const cdn = fakeCdn();
  const locations = [
    urlLocation(`http://localhost:${expired.port}/old`),
    urlLocation(`http://localhost:${cdn.port}/new`, { Referer: REFERER }),
  ];
  let locateCalls = 0;
  const dependencies = {
    locate: async () => locations[Math.min(locateCalls++, locations.length - 1)],
    onRangesIgnored: () => {},
  };
  const response = await serveWholeVideo(dependencies, item, new Request("http://x/media"));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(BODY);
  expect(locateCalls).toBe(2);
});

test("a stream that stays stale fails with 502 after one retry", async () => {
  const expired = serve(() => new Response(null, { status: 410 }));
  let locateCalls = 0;
  const dependencies = {
    locate: async () => {
      locateCalls += 1;
      return urlLocation(`http://localhost:${expired.port}/old`);
    },
    onRangesIgnored: () => {},
  };
  await expect(serveWholeVideo(dependencies, item, new Request("http://x/media"))).rejects.toMatchObject({ status: 502 });
  expect(locateCalls).toBe(2);
});

test("an unreachable host is retried through the source as well", async () => {
  const cdn = fakeCdn();
  let locateCalls = 0;
  const dependencies = {
    locate: async () => {
      locateCalls += 1;
      if (locateCalls === 1) {
        return urlLocation("http://localhost:1/gone");
      }
      return urlLocation(`http://localhost:${cdn.port}/v`, { Referer: REFERER });
    },
    onRangesIgnored: () => {},
  };
  const response = await serveWholeVideo(dependencies, item, new Request("http://x/media"));
  expect(await response.text()).toBe(BODY);
});

test("playback falls back to clips when the source ignores Range", async () => {
  const upstream = serve(() => new Response(BODY, { status: 200 }));
  const flagged: string[] = [];
  const dependencies = {
    locate: async () => urlLocation(`http://localhost:${upstream.port}/v`),
    onRangesIgnored: (flaggedItem: Item) => flagged.push(flaggedItem.id),
  };
  await serveWholeVideo(dependencies, item, new Request("http://x/media", { headers: { Range: "bytes=0-3" } }));
  expect(flagged).toEqual(["i"]);
});

test("HLS sources answer 415", async () => {
  const dependencies = {
    locate: async () => urlLocation("https://cdn.example.com/a.m3u8?token=1"),
    onRangesIgnored: () => {},
  };
  await expect(serveWholeVideo(dependencies, item, new Request("http://x/media"))).rejects.toMatchObject({ status: 415 });
});

test("local video bounds an open-ended range and keeps the player seeking", async () => {
  const file = path.join(directory, "big.mp4");
  fs.writeFileSync(file, Buffer.alloc(MAX_RANGE_BYTES * 3));
  const response = serveLocalFile(file, new Request("http://x/media", { headers: { Range: "bytes=0-" } }));
  expect(response.status).toBe(206);
  expect((await response.arrayBuffer()).byteLength).toBe(MAX_RANGE_BYTES);
  expect(response.headers.get("content-range")).toBe(`bytes 0-${MAX_RANGE_BYTES - 1}/${MAX_RANGE_BYTES * 3}`);
  expect(response.headers.get("accept-ranges")).toBe("bytes");
});

test("local video serves explicit ranges, 416 and 304", async () => {
  const file = path.join(directory, "small.mp4");
  fs.writeFileSync(file, BODY);
  const slice = serveLocalFile(file, new Request("http://x/m", { headers: { Range: "bytes=2-4" } }));
  expect(slice.status).toBe(206);
  expect(await slice.text()).toBe("234");
  const beyond = serveLocalFile(file, new Request("http://x/m", { headers: { Range: "bytes=50-" } }));
  expect(beyond.status).toBe(416);
  const whole = serveLocalFile(file, new Request("http://x/m"));
  const revalidated = serveLocalFile(file, new Request("http://x/m", { headers: { "if-none-match": whole.headers.get("etag") || "" } }));
  expect(revalidated.status).toBe(304);
  expect(() => serveLocalFile(path.join(directory, "none.mp4"), new Request("http://x/m"))).toThrow();
});
