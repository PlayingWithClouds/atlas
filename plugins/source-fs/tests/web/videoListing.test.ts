import { expect, test } from "bun:test";
import { formatDuration, videoListingPath } from "../../src/web/videoListing";

test("listing path encodes the search text", () => {
  expect(videoListingPath("a b/c")).toBe("/sources/fs/videofile/items?search=a%20b%2Fc&limit=40&offset=0");
});

test("durations render as m:ss", () => {
  expect(formatDuration(0)).toBe("0:00");
  expect(formatDuration(125.4)).toBe("2:05");
});
