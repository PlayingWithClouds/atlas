import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { SCENE_FLOOR_TIMEOUT_MS, parseSceneCuts, readSceneCutFile, sceneFilter, sceneTimeoutMs, writeSceneCutFile } from "../src/scenes";

// Real ffmpeg output: the metadata filter prints a frame line per selected frame,
// followed by the score that selected it.
const SCENE_OUTPUT = `frame:0    pts:0       pts_time:0
lavfi.scene_score=0.000000
frame:31   pts:31744   pts_time:1.322667
lavfi.scene_score=0.412331
frame:96   pts:98304   pts_time:4.096
lavfi.scene_score=0.884019
`;

test("parseSceneCuts reads pts_time lines", () => {
  expect(parseSceneCuts(SCENE_OUTPUT)).toEqual([0, 1.322667, 4.096]);
});

test("parseSceneCuts ignores score lines and truncated lines", () => {
  const output = "lavfi.scene_score=0.5\nframe:1 pts:1024 pts_time:0.04\nframe:2 pts:20";
  expect(parseSceneCuts(output)).toEqual([0.04]);
  expect(parseSceneCuts("")).toEqual([]);
});

test("scene timeout has a floor and grows with long videos", () => {
  expect(sceneTimeoutMs(30)).toBe(SCENE_FLOOR_TIMEOUT_MS);
  expect(sceneTimeoutMs(7200)).toBeGreaterThan(SCENE_FLOOR_TIMEOUT_MS);
});

test("scene filter downscales before scoring", () => {
  expect(sceneFilter(0.3)).toBe("scale=w=160:h=-2,select='gt(scene,0.300)',metadata=print:file=-");
});

test("cached cuts are only valid for the threshold and duration they came from", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scenes-"));
  const file = path.join(directory, "nested", "cuts.json");
  try {
    expect(readSceneCutFile(file, 0.3, 60)).toBeUndefined();
    writeSceneCutFile(file, { threshold: 0.3, duration: 60, cuts: [3, 9] });
    expect(readSceneCutFile(file, 0.3, 60)).toEqual([3, 9]);
    expect(readSceneCutFile(file, 0.4, 60)).toBeUndefined();
    expect(readSceneCutFile(file, 0.3, 61)).toBeUndefined();
    writeSceneCutFile(file, { threshold: 0.3, duration: 60, cuts: [] });
    expect(readSceneCutFile(file, 0.3, 60)).toBeUndefined();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
