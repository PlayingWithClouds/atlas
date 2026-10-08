import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Item } from "@atlas/contracts";
import type { MediaLocation } from "@atlas/contracts/server";
import { MediaCaches } from "../src/caches";
import type { VideoTools } from "../src/ffmpeg";
import { VideoMedia } from "../src/videoMedia";

let directory: string;
let caches: MediaCaches;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "video-media-"));
  caches = new MediaCaches(directory);
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function clipItem(span = { start: 1256, end: 1260 }): Item {
  return {
    id: "i1",
    sessionId: "session",
    index: 0,
    ref: `/videos/feature.mp4#t=${span.start.toFixed(3)},${span.end.toFixed(3)}`,
    mediaKind: "video",
    status: "pending",
    annotations: [],
    embedded: false,
    span,
    meta: {},
  };
}

interface ToolCalls {
  cuts: string[];
  frames: number[];
  detections: number;
  active: number;
  peakActive: number;
}

function fakeTools(calls: ToolCalls, overrides: Partial<VideoTools> = {}): VideoTools {
  const hold = async () => {
    calls.active += 1;
    calls.peakActive = Math.max(calls.peakActive, calls.active);
    await Bun.sleep(15);
    calls.active -= 1;
  };
  return {
    probeDuration: async () => 100,
    cutClip: async (_location, outputPath, span) => {
      await hold();
      calls.cuts.push(`${span.start}-${span.end}`);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "clip");
      return true;
    },
    seekFrame: async (_location, outputPath, seconds) => {
      calls.frames.push(seconds);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "jpg");
      return true;
    },
    detectSceneCuts: async () => {
      calls.detections += 1;
      return [];
    },
    tileImages: async () => undefined,
    ...overrides,
  };
}

function newCalls(): ToolCalls {
  return { cuts: [], frames: [], detections: 0, active: 0, peakActive: 0 };
}

function mediaWith(tools: VideoTools, locate?: (item: Item) => Promise<MediaLocation>): VideoMedia {
  return new VideoMedia({
    tools,
    caches,
    locate: locate || (async () => ({ kind: "file", path: "/videos/feature.mp4" })),
    fallbackDuration: () => undefined,
  });
}

test("a cached clip is served without encoding or consulting the source", async () => {
  const item = clipItem();
  const cachedPath = caches.clipPath("session", item.ref);
  fs.mkdirSync(path.dirname(cachedPath), { recursive: true });
  fs.writeFileSync(cachedPath, "cached cut");
  const calls = newCalls();
  const media = mediaWith(fakeTools(calls), async () => {
    throw new Error("the source must not be consulted on a cache hit");
  });
  expect(await media.ensureClip(item, item.span!)).toBe(cachedPath);
  expect(calls.cuts).toEqual([]);
});

test("clip files are keyed by the exact range and end in .mp4", () => {
  const stored = caches.clipPath("s", "/v.mp4#t=10.000,14.000");
  const trimmed = caches.clipPath("s", "/v.mp4#t=10.500,14.000");
  expect(stored).not.toBe(trimmed);
  expect(stored.endsWith(".mp4")).toBe(true);
  expect(path.basename(stored)).toMatch(/^[0-9a-f]{16}\.mp4$/);
});

test("a trim preview encodes its own range, then hits the cache", async () => {
  const item = clipItem();
  const calls = newCalls();
  const media = mediaWith(fakeTools(calls));
  const stored = await media.ensureClip(item, item.span!);
  const preview = await media.ensureClip(item, { start: 1256.5, end: 1260 });
  expect(stored).not.toBe(preview);
  await media.ensureClip(item, { start: 1256.5, end: 1260 });
  expect(calls.cuts).toEqual(["1256-1260", "1256.5-1260"]);
});

test("concurrent requests for one clip share a single encode", async () => {
  const item = clipItem();
  const calls = newCalls();
  const media = mediaWith(fakeTools(calls));
  const results = await Promise.all([1, 2, 3, 4].map(() => media.ensureClip(item, item.span!)));
  expect(new Set(results).size).toBe(1);
  expect(calls.cuts.length).toBe(1);
});

test("at most two clips encode at once", async () => {
  const calls = newCalls();
  const media = mediaWith(fakeTools(calls));
  const spans = [0, 1, 2, 3, 4, 5].map((start) => ({ start, end: start + 1 }));
  await Promise.all(spans.map((span) => media.ensureClip(clipItem(span), span)));
  expect(calls.cuts.length).toBe(6);
  expect(calls.peakActive).toBeLessThanOrEqual(2);
});

test("a failed encode leaves nothing cached and reports undefined", async () => {
  const calls = newCalls();
  const media = mediaWith(fakeTools(calls, { cutClip: async () => false }));
  expect(await media.ensureClip(clipItem(), { start: 1, end: 2 })).toBeUndefined();
});

test("posters sit at the span midpoint, or 10 percent into a whole video", async () => {
  const calls = newCalls();
  const media = mediaWith(fakeTools(calls));
  await media.ensurePoster(clipItem({ start: 10, end: 14 }));
  const whole = { ...clipItem(), ref: "/videos/feature.mp4", span: undefined };
  await media.ensurePoster(whole as Item);
  expect(calls.frames).toEqual([12, 10]);
  await media.ensurePoster(clipItem({ start: 10, end: 14 }));
  expect(calls.frames.length).toBe(2);
});

test("empty scene detection is not cached, a real one is", async () => {
  const calls = newCalls();
  let cuts: number[] = [];
  const media = mediaWith(
    fakeTools(calls, {
      detectSceneCuts: async () => {
        calls.detections += 1;
        return cuts;
      },
    }),
  );
  const item = clipItem();
  expect(await media.sceneCuts(item, 0.3)).toBeUndefined();
  expect(await media.sceneCuts(item, 0.3)).toBeUndefined();
  expect(calls.detections).toBe(2);
  cuts = [3.5, 9];
  expect(await media.sceneCuts(item, 0.3)).toEqual([3.5, 9]);
  expect(await media.sceneCuts(item, 0.3)).toEqual([3.5, 9]);
  expect(calls.detections).toBe(3);
  // A different threshold re-detects.
  await media.sceneCuts(item, 0.4);
  expect(calls.detections).toBe(4);
});

test("removing a session deletes its clips and posters but keeps scene cuts", async () => {
  const calls = newCalls();
  const media = mediaWith(fakeTools(calls, { detectSceneCuts: async () => [2] }));
  const item = clipItem();
  await media.ensureClip(item, item.span!);
  await media.ensurePoster(item);
  await media.sceneCuts(item, 0.3);
  caches.removeSession("session");
  expect(fs.existsSync(path.join(directory, "clips", "session"))).toBe(false);
  expect(fs.existsSync(path.join(directory, "posters", "session"))).toBe(false);
  expect(fs.existsSync(caches.scenesPath("/videos/feature.mp4"))).toBe(true);
});
