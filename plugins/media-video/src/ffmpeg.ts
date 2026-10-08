import fs from "node:fs";
import path from "node:path";
import type { Span } from "@atlas/contracts";
import type { MediaLocation } from "@atlas/contracts/server";
import { fileHasContent } from "./caches";
import { isHlsLocation } from "./range";
import { parseSceneCuts, sceneFilter, sceneTimeoutMs } from "./scenes";

/**
 * A CDN can accept the connection and then stop sending, which leaves ffmpeg waiting on a
 * socket that never closes. Every invocation carries a deadline.
 */
export const PROBE_TIMEOUT_MS = 30_000;
export const SEEK_TIMEOUT_MS = 60_000;
export const CUT_TIMEOUT_MS = 180_000;
export const TILE_TIMEOUT_MS = 60_000;

export const POSTER_WIDTH = 480;

/** Everything the plugin asks of ffmpeg; faked in tests that must not spawn processes. */
export interface VideoTools {
  probeDuration(location: MediaLocation): Promise<number | undefined>;
  cutClip(location: MediaLocation, outputPath: string, span: Span): Promise<boolean>;
  /** `maxWidth` downscales the still; omit it to keep the source resolution. */
  seekFrame(location: MediaLocation, outputPath: string, seconds: number, maxWidth?: number): Promise<boolean>;
  detectSceneCuts(location: MediaLocation, threshold: number, duration: number): Promise<number[] | undefined>;
  tileImages(imagePaths: (string | undefined)[], tile: TileLayout): Promise<Uint8Array | undefined>;
}

export interface TileLayout {
  columns: number;
  tileWidth: number;
  tileHeight: number;
}

interface ProcessResult {
  ok: boolean;
  output: Uint8Array;
}

function headerArguments(headers: Record<string, string> | undefined): string[] {
  if (headers === undefined || Object.keys(headers).length === 0) {
    return [];
  }
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
  return ["-headers", lines.join("")];
}

/** Proxied HLS segments often lack a media extension, which ffmpeg's HLS demuxer rejects by default. */
function formatArguments(location: MediaLocation): string[] {
  if (location.kind === "url" && isHlsLocation(location)) {
    return ["-extension_picky", "0"];
  }
  return [];
}

export function inputArguments(location: MediaLocation): string[] {
  if (location.kind === "file") {
    return ["-i", location.path];
  }
  return [...headerArguments(location.headers), ...formatArguments(location), "-i", location.url];
}

function seconds(value: number): string {
  return value.toFixed(3);
}

/** Places each image in a fixed-size cell; a missing image becomes a dark cell. */
export function tileFilterGraph(imagePaths: (string | undefined)[], tile: TileLayout): string {
  const { tileWidth, tileHeight, columns } = tile;
  const rows = Math.ceil(imagePaths.length / columns);
  // 4:4:4 throughout: the 135-row tile height is odd, which 4:2:0 chroma rounds to 134.
  const cellFilter = `format=yuv444p,scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=increase,crop=${tileWidth}:${tileHeight},setsar=1`;
  const parts: string[] = [];
  let inputIndex = 0;
  imagePaths.forEach((imagePath, position) => {
    if (imagePath === undefined) {
      parts.push(`color=c=0x101010:s=${tileWidth}x${tileHeight},format=yuv444p,trim=end_frame=1[cell${position}]`);
      return;
    }
    parts.push(`[${inputIndex}:v]${cellFilter},trim=end_frame=1,setpts=PTS-STARTPTS[cell${position}]`);
    inputIndex += 1;
  });
  const labels = imagePaths.map((_, position) => `[cell${position}]`).join("");
  parts.push(`${labels}concat=n=${imagePaths.length}:v=1:a=0,tile=${columns}x${rows}:padding=0:margin=0:color=0x101010[sheet]`);
  return parts.join(";");
}

/** Receives ffmpeg's error output when a call fails; failures are otherwise silent fallbacks. */
export type FailureReporter = (message: string) => void;

function lastLines(text: string): string {
  return text.trim().split("\n").slice(-3).join(" | ");
}

/** The input URL or path, shortened: signed stream URLs run to hundreds of characters. */
function inputOf(args: string[]): string {
  const flagIndex = args.indexOf("-i");
  if (flagIndex === -1 || flagIndex + 1 >= args.length) {
    return "?";
  }
  return args[flagIndex + 1].slice(0, 120);
}

export class FfmpegTools implements VideoTools {
  private readonly running = new Set<ReturnType<typeof Bun.spawn>>();
  private stopped = false;

  constructor(private readonly reportFailure: FailureReporter = () => {}) {}

  /** Kills every process still running; called when the plugin unloads. */
  stop(): void {
    this.stopped = true;
    for (const subprocess of this.running) {
      subprocess.kill();
    }
    this.running.clear();
  }

  async probeDuration(location: MediaLocation): Promise<number | undefined> {
    const target = location.kind === "file" ? location.path : location.url;
    const args = ["-v", "error"];
    if (location.kind === "url") {
      args.push(...headerArguments(location.headers), ...formatArguments(location));
    }
    args.push("-show_entries", "format=duration", "-of", "default=nk=1:nw=1", target);
    const result = await this.run("ffprobe", args, PROBE_TIMEOUT_MS);
    const duration = Number(Buffer.from(result.output).toString("utf8").trim());
    if (!result.ok || !Number.isFinite(duration)) {
      return undefined;
    }
    return duration;
  }

  /**
   * Re-encodes rather than stream-copies: a copy snaps to keyframes, so the clip that plays
   * would not be the range that gets labeled. Output goes to `.partial` first so a killed
   * ffmpeg never leaves a truncated clip behind for the cache to serve.
   */
  async cutClip(location: MediaLocation, outputPath: string, span: Span): Promise<boolean> {
    const partialPath = `${outputPath}.partial`;
    const args = ["-y", "-nostdin", "-loglevel", "error", "-ss", seconds(span.start), ...inputArguments(location)];
    args.push("-t", seconds(span.end - span.start));
    args.push("-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-movflags", "+faststart");
    args.push("-f", "mp4", partialPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const result = await this.run("ffmpeg", args, CUT_TIMEOUT_MS);
    return this.publish(result.ok, partialPath, outputPath);
  }

  async seekFrame(
    location: MediaLocation,
    outputPath: string,
    seekSeconds: number,
    maxWidth?: number,
  ): Promise<boolean> {
    const partialPath = `${outputPath}.partial.jpg`;
    const args = ["-y", "-nostdin", "-loglevel", "error", "-ss", seconds(seekSeconds), ...inputArguments(location)];
    args.push("-frames:v", "1");
    if (maxWidth !== undefined) {
      args.push("-vf", `scale='min(${maxWidth},iw)':-2`);
    }
    args.push("-q:v", "3", partialPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const result = await this.run("ffmpeg", args, SEEK_TIMEOUT_MS);
    return this.publish(result.ok, partialPath, outputPath);
  }

  async detectSceneCuts(location: MediaLocation, threshold: number, duration: number): Promise<number[] | undefined> {
    const args = ["-nostdin", "-loglevel", "error", ...inputArguments(location)];
    args.push("-filter:v", sceneFilter(threshold), "-an", "-sn", "-f", "null", "-");
    const result = await this.run("ffmpeg", args, sceneTimeoutMs(duration));
    if (!result.ok) {
      return undefined;
    }
    return parseSceneCuts(Buffer.from(result.output).toString("utf8"));
  }

  async tileImages(imagePaths: (string | undefined)[], tile: TileLayout): Promise<Uint8Array | undefined> {
    const args = ["-y", "-nostdin", "-loglevel", "error"];
    for (const imagePath of imagePaths) {
      if (imagePath !== undefined) {
        args.push("-i", imagePath);
      }
    }
    args.push("-filter_complex", tileFilterGraph(imagePaths, tile), "-map", "[sheet]");
    args.push("-frames:v", "1", "-q:v", "4", "-pix_fmt", "yuvj444p", "-f", "mjpeg", "pipe:1");
    const result = await this.run("ffmpeg", args, TILE_TIMEOUT_MS);
    if (!result.ok || result.output.length === 0) {
      return undefined;
    }
    return result.output;
  }

  private publish(succeeded: boolean, partialPath: string, outputPath: string): boolean {
    if (succeeded && fileHasContent(partialPath)) {
      fs.renameSync(partialPath, outputPath);
      return true;
    }
    fs.rmSync(partialPath, { force: true });
    return false;
  }

  private async run(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
    if (this.stopped) {
      return { ok: false, output: new Uint8Array() };
    }
    let subprocess: ReturnType<typeof Bun.spawn>;
    try {
      subprocess = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      return { ok: false, output: new Uint8Array() };
    }
    this.running.add(subprocess);
    const timer = setTimeout(() => subprocess.kill(), timeoutMs);
    try {
      const [output, errorText] = await Promise.all([
        new Response(subprocess.stdout as ReadableStream).arrayBuffer(),
        new Response(subprocess.stderr as ReadableStream).text(),
      ]);
      const exitCode = await subprocess.exited;
      if (exitCode !== 0 && !this.stopped) {
        this.reportFailure(`${command} exited with ${exitCode}: ${lastLines(errorText)} (input ${inputOf(args)})`);
      }
      return { ok: exitCode === 0, output: new Uint8Array(output) };
    } finally {
      clearTimeout(timer);
      this.running.delete(subprocess);
    }
  }
}
