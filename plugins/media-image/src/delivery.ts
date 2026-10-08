import fs from "node:fs";
import { HttpError } from "@atlas/contracts/server";
import type { MediaLocation } from "@atlas/contracts/server";

const CACHE_CONTROL = "private, max-age=300";

function etagOf(stats: fs.Stats): string {
  return `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
}

function statFile(path: string): fs.Stats {
  try {
    const stats = fs.statSync(path);
    if (stats.isFile()) {
      return stats;
    }
  } catch (error) {
    // Falls through to the 404 below.
  }
  throw new HttpError(404, "media file not found");
}

function isFresh(request: Request, etag: string): boolean {
  return request.headers.get("if-none-match") === etag;
}

export function serveFile(path: string, request: Request): Response {
  const stats = statFile(path);
  const etag = etagOf(stats);
  const headers: Record<string, string> = {
    ETag: etag,
    "Last-Modified": stats.mtime.toUTCString(),
    "Cache-Control": CACHE_CONTROL,
  };
  if (isFresh(request, etag)) {
    return new Response(null, { status: 304, headers });
  }
  const file = Bun.file(path);
  headers["Content-Type"] = file.type;
  headers["Content-Length"] = String(stats.size);
  return new Response(file, { status: 200, headers });
}

function upstreamHeadersOf(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = { "Cache-Control": CACHE_CONTROL };
  const contentType = upstream.headers.get("content-type");
  const contentLength = upstream.headers.get("content-length");
  if (contentType !== null) {
    headers["Content-Type"] = contentType;
  }
  if (contentLength !== null && !upstream.headers.has("content-encoding")) {
    headers["Content-Length"] = contentLength;
  }
  return headers;
}

export async function fetchUpstream(location: Extract<MediaLocation, { kind: "url" }>): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(location.url, { headers: location.headers });
  } catch (error) {
    throw new HttpError(502, `upstream fetch failed: ${(error as Error).message}`);
  }
  if (!upstream.ok) {
    throw new HttpError(502, `upstream responded ${upstream.status}`);
  }
  return upstream;
}

export async function serveUrl(location: Extract<MediaLocation, { kind: "url" }>): Promise<Response> {
  const upstream = await fetchUpstream(location);
  return new Response(upstream.body, { status: 200, headers: upstreamHeadersOf(upstream) });
}

/** Reads the whole image, for the resizing paths. */
export async function readBytes(location: MediaLocation): Promise<Buffer> {
  if (location.kind === "file") {
    statFile(location.path);
    return Buffer.from(await Bun.file(location.path).arrayBuffer());
  }
  const upstream = await fetchUpstream(location);
  return Buffer.from(await upstream.arrayBuffer());
}

export function serveLocation(location: MediaLocation, request: Request): Response | Promise<Response> {
  if (location.kind === "file") {
    return serveFile(location.path, request);
  }
  return serveUrl(location);
}
