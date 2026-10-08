export const MAX_RANGE_BYTES = 4 << 20;

/** Request headers forwarded upstream so seeking and revalidation keep working through the proxy. */
export const PASS_THROUGH_REQUEST_HEADERS = ["range", "if-range", "if-none-match", "if-modified-since"];

/** Response headers copied back; Content-Length and Content-Range must survive intact. */
export const PASS_THROUGH_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];

/**
 * Rewrites an open-ended `bytes=N-` into a slice of at most MAX_RANGE_BYTES. A player asks for
 * the rest of the file but only buffers a few seconds, which would leave the connection parked
 * mid-body. Total size may be 0 (unknown) when proxying. Anything that is not a single
 * open-ended range is left alone.
 */
export function boundedRange(header: string | null, totalSize: number): string | undefined {
  const prefix = "bytes=";
  if (header === null || !header.startsWith(prefix)) {
    return undefined;
  }
  const spec = header.slice(prefix.length).trim();
  if (!spec.endsWith("-") || spec.includes(",")) {
    return undefined;
  }
  const startText = spec.slice(0, -1);
  if (!/^\d+$/.test(startText)) {
    return undefined;
  }
  const start = Number(startText);
  if (totalSize > 0 && start >= totalSize) {
    return undefined;
  }
  const end = start + MAX_RANGE_BYTES - 1;
  if (totalSize > 0 && end >= totalSize - 1) {
    return undefined;
  }
  return `${prefix}${start}-${end}`;
}

export type ByteRange = { start: number; end: number };

/** A single `bytes=` range resolved against a file size; "unsatisfiable" maps to 416. */
export function parseSingleRange(header: string | null, size: number): ByteRange | "unsatisfiable" | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header || "").trim());
  if (match === null || (match[1] === "" && match[2] === "")) {
    return undefined;
  }
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (suffixLength === 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(size - suffixLength, 0), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) {
    return "unsatisfiable";
  }
  return { start, end };
}

/** Statuses meaning the stored stream URL went stale (expired signature, moved, gone). */
export function isStaleStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 410;
}

export function isHlsUrl(url: string): boolean {
  const cut = url.search(/[?#]/);
  const pathname = cut === -1 ? url : url.slice(0, cut);
  return pathname.toLowerCase().endsWith(".m3u8");
}

/** Sources flag playlists whose URL hides it (e.g. a proxy route) with `format: "hls"`. */
export function isHlsLocation(location: { url: string; format?: string }): boolean {
  return location.format === "hls" || isHlsUrl(location.url);
}

/**
 * True when the source cannot answer byte ranges: it replied 200 to a range request, or says
 * so outright. The session then falls back to playing cut clips.
 */
export function ignoresRanges(requestRange: string | null, status: number, acceptRanges: string | null): boolean {
  if (requestRange !== null && requestRange !== "" && status === 200) {
    return true;
  }
  return acceptRanges !== null && acceptRanges.toLowerCase() === "none";
}
