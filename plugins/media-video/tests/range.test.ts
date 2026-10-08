import { expect, test } from "bun:test";
import { resolveClipRange, MINIMUM_SPAN_SECONDS } from "../src/clipRange";
import { MAX_RANGE_BYTES, boundedRange, ignoresRanges, isHlsUrl, isStaleStatus, parseSingleRange } from "../src/range";

const TOTAL = 100 << 20;

test("boundedRange only clamps open-ended ranges", () => {
  const bounded = (start: number) => `bytes=${start}-${start + MAX_RANGE_BYTES - 1}`;
  // The case that starves the connection pool: bound it.
  expect(boundedRange("bytes=0-", TOTAL)).toBe(bounded(0));
  expect(boundedRange("bytes=1000-", TOTAL)).toBe(bounded(1000));
  // Unknown total (proxying) is still bounded.
  expect(boundedRange("bytes=0-", 0)).toBe(bounded(0));
  // Already bounded, a suffix range, a multi-range, or no range: untouched.
  expect(boundedRange("bytes=0-1023", TOTAL)).toBeUndefined();
  expect(boundedRange("bytes=-1024", TOTAL)).toBeUndefined();
  expect(boundedRange("bytes=0-,2048-", TOTAL)).toBeUndefined();
  expect(boundedRange("", TOTAL)).toBeUndefined();
  expect(boundedRange(null, TOTAL)).toBeUndefined();
  // The remainder already fits in one slice.
  expect(boundedRange("bytes=0-", MAX_RANGE_BYTES)).toBeUndefined();
  // Past the end: the real 416 comes from the file or upstream.
  expect(boundedRange(`bytes=${TOTAL}-`, TOTAL)).toBeUndefined();
});

test("parseSingleRange resolves against the file size", () => {
  expect(parseSingleRange("bytes=0-3", 10)).toEqual({ start: 0, end: 3 });
  expect(parseSingleRange("bytes=4-", 10)).toEqual({ start: 4, end: 9 });
  expect(parseSingleRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
  expect(parseSingleRange("bytes=2-999", 10)).toEqual({ start: 2, end: 9 });
  expect(parseSingleRange("bytes=10-", 10)).toBe("unsatisfiable");
  expect(parseSingleRange("bytes=0-1,4-5", 10)).toBeUndefined();
  expect(parseSingleRange(null, 10)).toBeUndefined();
});

test("HLS is recognised by path, not by query", () => {
  expect(isHlsUrl("https://cdn.example.com/a.m3u8")).toBe(true);
  expect(isHlsUrl("https://cdn.example.com/a.M3U8?token=1")).toBe(true);
  expect(isHlsUrl("https://cdn.example.com/a.mp4?list=b.m3u8")).toBe(false);
});

test("stale statuses are the ones a refreshed URL can fix", () => {
  for (const status of [401, 403, 404, 410]) {
    expect(isStaleStatus(status)).toBe(true);
  }
  for (const status of [200, 206, 416, 500, 502]) {
    expect(isStaleStatus(status)).toBe(false);
  }
});

test("ignoresRanges flags a 200 to a range request or Accept-Ranges: none", () => {
  expect(ignoresRanges("bytes=0-3", 200, null)).toBe(true);
  expect(ignoresRanges("bytes=0-3", 206, "bytes")).toBe(false);
  expect(ignoresRanges(null, 200, "bytes")).toBe(false);
  expect(ignoresRanges(null, 200, "none")).toBe(true);
});

test("resolveClipRange applies overrides and clamps to the video", () => {
  const stored = { start: 10, end: 14 };
  expect(resolveClipRange(stored, {}, 3600)).toEqual(stored);
  expect(resolveClipRange(stored, { start: 11.5, end: 99999 }, 3600)).toEqual({ start: 11.5, end: 3600 });
  const degenerate = resolveClipRange(stored, { start: 20, end: 20.01 }, 3600);
  expect(degenerate.end - degenerate.start).toBeCloseTo(MINIMUM_SPAN_SECONDS);
});
