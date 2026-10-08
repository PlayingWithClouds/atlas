import fs from "node:fs";
import path from "node:path";
import { parseSpanRef, spanRef } from "@atlas/contracts";
import type { Item, Span } from "@atlas/contracts";
import type { MediaLocation } from "@atlas/contracts/server";
import { fileHasContent } from "./caches";
import type { MediaCaches } from "./caches";
import { Semaphore, SingleFlight } from "./concurrency";
import { POSTER_WIDTH } from "./ffmpeg";
import type { VideoTools } from "./ffmpeg";
import { readSceneCutFile, writeSceneCutFile } from "./scenes";

const MAX_CONCURRENT_ENCODES = 2;
const MAX_CONCURRENT_POSTERS = 6;
const WHOLE_VIDEO_POSTER_FRACTION = 0.1;

export interface VideoMediaDependencies {
  tools: VideoTools;
  caches: MediaCaches;
  locate(item: Item): Promise<MediaLocation>;
  /** Duration known from the session, used only when probing fails. */
  fallbackDuration(item: Item): number | undefined;
}

/** The video-side cache: clips, posters, scene cuts and durations, each computed at most once. */
export class VideoMedia {
  private readonly encodeSlots = new Semaphore(MAX_CONCURRENT_ENCODES);
  private readonly posterSlots = new Semaphore(MAX_CONCURRENT_POSTERS);
  private readonly sceneSlots = new Semaphore(1);
  private readonly clipFlights = new SingleFlight<string | undefined>();
  private readonly posterFlights = new SingleFlight<string | undefined>();
  private readonly sceneFlights = new SingleFlight<number[] | undefined>();
  private readonly durations = new Map<string, number>();

  constructor(private readonly dependencies: VideoMediaDependencies) {}

  get caches(): MediaCaches {
    return this.dependencies.caches;
  }

  /** The video's own ref: a span item's ref minus its fragment. */
  videoRefOf(item: Item): string {
    return parseSpanRef(item.ref).ref;
  }

  async durationOf(item: Item): Promise<number | undefined> {
    const known = item.meta.duration;
    if (typeof known === "number" && known > 0) {
      return known;
    }
    const videoRef = this.videoRefOf(item);
    const memoized = this.durations.get(videoRef);
    if (memoized !== undefined) {
      return memoized;
    }
    const probed = await this.dependencies.tools.probeDuration(await this.dependencies.locate(item));
    if (probed === undefined || probed <= 0) {
      return this.dependencies.fallbackDuration(item);
    }
    this.durations.set(videoRef, probed);
    return probed;
  }

  /**
   * Returns the cached cut for a span, encoding it first when needed. The cache is checked
   * before the source is consulted, so a hit never touches the network.
   */
  async ensureClip(item: Item, span: Span): Promise<string | undefined> {
    const clipRef = spanRef(this.videoRefOf(item), span);
    const clipPath = this.caches.clipPath(item.sessionId, clipRef);
    if (fileHasContent(clipPath)) {
      return clipPath;
    }
    return this.clipFlights.run(clipPath, () =>
      this.encodeSlots.run(() => this.encodeClip(item, span, clipPath)),
    );
  }

  /** Poster at the span's midpoint, or 10% into a whole video. */
  async ensurePoster(item: Item): Promise<string | undefined> {
    const posterPath = this.caches.posterPath(item.sessionId, item.ref);
    if (fileHasContent(posterPath)) {
      return posterPath;
    }
    return this.posterFlights.run(posterPath, () =>
      this.posterSlots.run(() => this.cutPoster(item, posterPath)),
    );
  }

  /** Full-resolution still for frame extraction; shares the poster concurrency cap. */
  async extractFrame(item: Item, seconds: number, outputPath: string): Promise<boolean> {
    if (fileHasContent(outputPath)) {
      return true;
    }
    const location = await this.dependencies.locate(item);
    return this.posterSlots.run(() => this.dependencies.tools.seekFrame(location, outputPath, seconds));
  }

  /** Cut positions of the whole video; undefined when detection failed or found nothing. */
  async sceneCuts(item: Item, threshold: number): Promise<number[] | undefined> {
    const duration = await this.durationOf(item);
    if (duration === undefined || threshold <= 0) {
      return undefined;
    }
    const cachePath = this.caches.scenesPath(this.videoRefOf(item));
    const cached = readSceneCutFile(cachePath, threshold, duration);
    if (cached !== undefined) {
      return cached;
    }
    const flightKey = `${cachePath}:${threshold}`;
    return this.sceneFlights.run(flightKey, () =>
      this.sceneSlots.run(() => this.detectScenes(item, threshold, duration, cachePath)),
    );
  }

  private async encodeClip(item: Item, span: Span, clipPath: string): Promise<string | undefined> {
    if (fileHasContent(clipPath)) {
      return clipPath;
    }
    fs.mkdirSync(path.dirname(clipPath), { recursive: true });
    const location = await this.dependencies.locate(item);
    if (!(await this.dependencies.tools.cutClip(location, clipPath, span))) {
      return undefined;
    }
    return clipPath;
  }

  private async cutPoster(item: Item, posterPath: string): Promise<string | undefined> {
    if (fileHasContent(posterPath)) {
      return posterPath;
    }
    const seconds = await this.posterSecond(item);
    const location = await this.dependencies.locate(item);
    if (!(await this.dependencies.tools.seekFrame(location, posterPath, seconds, POSTER_WIDTH))) {
      return undefined;
    }
    return posterPath;
  }

  private async posterSecond(item: Item): Promise<number> {
    if (item.span !== undefined) {
      return item.span.start + (item.span.end - item.span.start) / 2;
    }
    const duration = await this.durationOf(item);
    if (duration === undefined) {
      return 0;
    }
    return duration * WHOLE_VIDEO_POSTER_FRACTION;
  }

  private async detectScenes(
    item: Item,
    threshold: number,
    duration: number,
    cachePath: string,
  ): Promise<number[] | undefined> {
    // Another run may have detected the same video while this one waited for the slot.
    const cached = readSceneCutFile(cachePath, threshold, duration);
    if (cached !== undefined) {
      return cached;
    }
    const location = await this.dependencies.locate(item);
    const cuts = await this.dependencies.tools.detectSceneCuts(location, threshold, duration);
    // A dead source and a genuinely cut-free video are indistinguishable, and caching either
    // would freeze a failed pass in place.
    if (cuts === undefined || cuts.length === 0) {
      return undefined;
    }
    writeSceneCutFile(cachePath, { threshold, duration, cuts });
    return cuts;
  }
}
