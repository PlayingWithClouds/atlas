import fs from "node:fs";
import type { Item } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import type { MediaLocation } from "@atlas/contracts/server";
import {
  PASS_THROUGH_REQUEST_HEADERS,
  PASS_THROUGH_RESPONSE_HEADERS,
  boundedRange,
  ignoresRanges,
  isHlsUrl,
  isStaleStatus,
  parseSingleRange,
} from "./range";

type UrlLocation = Extract<MediaLocation, { kind: "url" }>;

export const SHORT_CACHE_CONTROL = "private, max-age=300";
export const IMMUTABLE_CACHE_CONTROL = "private, max-age=86400, immutable";

const MAX_REDIRECTS = 10;
const RESPONSE_HEADER_TIMEOUT_MS = 20_000;

// --- local files -------------------------------------------------------------------------

function etagOf(stats: fs.Stats): string {
  return `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
}

function statFile(filePath: string): fs.Stats {
  try {
    const stats = fs.statSync(filePath);
    if (stats.isFile()) {
      return stats;
    }
  } catch (error) {
    // Falls through to the 404 below.
  }
  throw new HttpError(404, "media file not found");
}

/** If-Range only keeps the range when it names the current validator. */
function rangeStillValid(request: Request, etag: string, lastModified: string): boolean {
  const ifRange = request.headers.get("if-range");
  return ifRange === null || ifRange === etag || ifRange === lastModified;
}

/**
 * Serves a file with ETag, Range and bounded open-ended ranges. Players ask for the rest of
 * the file but read a few seconds; bounding keeps every response finishing promptly.
 */
export function serveLocalFile(filePath: string, request: Request, cacheControl = SHORT_CACHE_CONTROL): Response {
  const stats = statFile(filePath);
  const etag = etagOf(stats);
  const lastModified = stats.mtime.toUTCString();
  const headers: Record<string, string> = {
    ETag: etag,
    "Last-Modified": lastModified,
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  const file = Bun.file(filePath);
  headers["Content-Type"] = file.type;
  const rangeHeader = boundedRange(request.headers.get("range"), stats.size) || request.headers.get("range");
  const range = rangeStillValid(request, etag, lastModified) ? parseSingleRange(rangeHeader, stats.size) : undefined;
  if (range === "unsatisfiable") {
    headers["Content-Range"] = `bytes */${stats.size}`;
    return new Response(null, { status: 416, headers });
  }
  if (range === undefined) {
    headers["Content-Length"] = String(stats.size);
    return new Response(file, { status: 200, headers });
  }
  headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stats.size}`;
  headers["Content-Length"] = String(range.end - range.start + 1);
  return new Response(file.slice(range.start, range.end + 1), { status: 206, headers });
}

// --- upstream proxy ----------------------------------------------------------------------

export type UpstreamOutcome =
  | { kind: "stale"; status: number }
  | { kind: "response"; response: Response; ignoredRange: boolean };

function upstreamRequestHeaders(location: UrlLocation, request: Request): Record<string, string> {
  const headers: Record<string, string> = { ...location.headers };
  for (const name of PASS_THROUGH_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null && value !== "") {
      headers[name] = value;
    }
  }
  const bounded = boundedRange(request.headers.get("range"), 0);
  if (bounded !== undefined) {
    headers.range = bounded;
  }
  // A transfer encoding layer would break the byte-range arithmetic.
  headers["accept-encoding"] = "identity";
  return headers;
}

/** Waits for response headers only; the body streams with no deadline. */
async function fetchWithHeaderTimeout(
  url: string,
  headers: Record<string, string>,
  method: string,
  clientSignal: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESPONSE_HEADER_TIMEOUT_MS);
  const abortOnClientGone = () => controller.abort();
  clientSignal.addEventListener("abort", abortOnClientGone);
  try {
    return await fetch(url, { method, headers, redirect: "manual", signal: controller.signal });
  } finally {
    clearTimeout(timer);
    clientSignal.removeEventListener("abort", abortOnClientGone);
  }
}

/** Follows redirects by hand so the CDN headers are re-applied on every hop, even cross-host. */
async function fetchFollowingRedirects(
  location: UrlLocation,
  headers: Record<string, string>,
  request: Request,
): Promise<Response> {
  let currentUrl = location.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchWithHeaderTimeout(currentUrl, headers, request.method, request.signal);
    const next = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || next === null) {
      return response;
    }
    await response.body?.cancel();
    currentUrl = new URL(next, currentUrl).toString();
  }
  throw new Error("too many redirects");
}

function responseHeadersOf(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = { "Cache-Control": SHORT_CACHE_CONTROL };
  for (const name of PASS_THROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null && value !== "") {
      headers[name] = value;
    }
  }
  if (upstream.headers.has("content-encoding")) {
    delete headers["content-length"];
  }
  return headers;
}

/**
 * Streams one upstream response. A stale status is reported without touching the body so the
 * caller can re-resolve the location and retry. Transport failures throw.
 */
export async function proxyUpstream(location: UrlLocation, request: Request): Promise<UpstreamOutcome> {
  const headers = upstreamRequestHeaders(location, request);
  const upstream = await fetchFollowingRedirects(location, headers, request);
  if (isStaleStatus(upstream.status)) {
    await upstream.body?.cancel();
    return { kind: "stale", status: upstream.status };
  }
  const ignoredRange = ignoresRanges(
    request.headers.get("range"),
    upstream.status,
    upstream.headers.get("accept-ranges"),
  );
  const response = new Response(upstream.body, { status: upstream.status, headers: responseHeadersOf(upstream) });
  return { kind: "response", response, ignoredRange };
}

// --- whole-video delivery ----------------------------------------------------------------

export interface WholeVideoDependencies {
  locate(item: Item): Promise<MediaLocation>;
  /** Called when the source ignores byte ranges, so the session can switch to clip playback. */
  onRangesIgnored(item: Item): void;
}

type ProxyAttempt = UpstreamOutcome | { kind: "failed"; message: string };

async function attemptProxy(location: UrlLocation, request: Request): Promise<ProxyAttempt> {
  try {
    return await proxyUpstream(location, request);
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

function describeFailure(attempt: ProxyAttempt): string {
  if (attempt.kind === "stale") {
    return `stream rejected the request: HTTP ${attempt.status}`;
  }
  if (attempt.kind === "failed") {
    return attempt.message;
  }
  return "";
}

function requirePlayableUrl(location: UrlLocation): void {
  if (isHlsUrl(location.url)) {
    throw new HttpError(415, "HLS source: play clips via /api/items/:id/clip");
  }
}

async function relocate(dependencies: WholeVideoDependencies, item: Item): Promise<MediaLocation> {
  try {
    return await dependencies.locate(item);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(502, `stream unavailable: ${message}`);
  }
}

function finishProxy(dependencies: WholeVideoDependencies, item: Item, attempt: ProxyAttempt): Response | undefined {
  if (attempt.kind !== "response") {
    return undefined;
  }
  if (attempt.ignoredRange) {
    dependencies.onRangesIgnored(item);
  }
  return attempt.response;
}

async function serveRemoteVideo(
  dependencies: WholeVideoDependencies,
  item: Item,
  location: UrlLocation,
  request: Request,
): Promise<Response> {
  requirePlayableUrl(location);
  const first = await attemptProxy(location, request);
  const served = finishProxy(dependencies, item, first);
  if (served !== undefined) {
    return served;
  }
  // A stored stream goes stale two ways: the signature expires, or its host is gone.
  // Both are fixed by asking the source once more.
  const fresh = await relocate(dependencies, item);
  if (fresh.kind === "file") {
    return serveLocalFile(fresh.path, request);
  }
  requirePlayableUrl(fresh);
  const second = await attemptProxy(fresh, request);
  const retried = finishProxy(dependencies, item, second);
  if (retried !== undefined) {
    return retried;
  }
  throw new HttpError(502, describeFailure(second));
}

/** Streams the item's whole underlying video with Range support. */
export async function serveWholeVideo(
  dependencies: WholeVideoDependencies,
  item: Item,
  request: Request,
): Promise<Response> {
  const location = await dependencies.locate(item);
  if (location.kind === "file") {
    return serveLocalFile(location.path, request);
  }
  return serveRemoteVideo(dependencies, item, location, request);
}
