import { attachSource } from './source';
import type { DetachSource } from './source';

/** Urgent stills fill the player area while previewing: up to this wide (the video's own width if smaller). */
const LARGE_WIDTH = 1280;
/** Background stills are filmstrip cells. */
const SMALL_WIDTH = 256;
/** Stills are cached per this many seconds. */
const CACHE_STEP_SECONDS = 0.1;
/** About 3.5 MB per large still and 150 KB per small one. */
const LARGE_CACHE_LIMIT = 24;
const SMALL_CACHE_LIMIT = 200;
const SEEK_TIMEOUT_MS = 8000;
/** A grabber nobody uses any more is kept this long in case the next item is the same video. */
const IDLE_RELEASE_MS = 30_000;

interface GrabRequest {
  seconds: number;
  urgent: boolean;
  owner?: object;
  resolve: (still: HTMLCanvasElement | undefined) => void;
}

function cacheKey(seconds: number): number {
  return Math.round(seconds / CACHE_STEP_SECONDS);
}

function waitFor(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`no ${event} in time`)), SEEK_TIMEOUT_MS);
    function finish(failure?: Error) {
      clearTimeout(timer);
      video.removeEventListener(event, onEvent);
      video.removeEventListener('error', onError);
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      resolve();
    }
    const onEvent = () => finish();
    const onError = () => finish(new Error('video failed to load'));
    video.addEventListener(event, onEvent);
    video.addEventListener('error', onError);
  });
}

function drawStill(video: HTMLVideoElement, maxWidth: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  let aspect = 16 / 9;
  let width = maxWidth;
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    aspect = video.videoWidth / video.videoHeight;
    width = Math.min(maxWidth, video.videoWidth);
  }
  canvas.width = width;
  canvas.height = Math.round(width / aspect);
  const context = canvas.getContext('2d');
  // A cross-origin video taints the canvas: it still displays, pixels just can't be read back.
  context?.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Grabs stills from a video with its own hidden <video> element, one seek at a time. Urgent
 * requests (the hover preview) jump the queue and replace each other: only the latest matters.
 */
function remember(cache: Map<number, HTMLCanvasElement>, limit: number, seconds: number, still: HTMLCanvasElement): HTMLCanvasElement {
  cache.set(cacheKey(seconds), still);
  if (cache.size > limit) {
    const oldest = cache.keys().next().value as number;
    cache.delete(oldest);
  }
  return still;
}

export class FrameGrabber {
  private readonly video = document.createElement('video');
  private readonly large = new Map<number, HTMLCanvasElement>();
  private readonly small = new Map<number, HTMLCanvasElement>();
  private queue: GrabRequest[] = [];
  private loaded: Promise<void>;
  private detach: DetachSource | undefined;
  private busy = false;
  private closed = false;

  constructor(url: string) {
    this.video.muted = true;
    this.video.preload = 'auto';
    this.video.playsInline = true;
    this.loaded = this.load(url);
    this.loaded.catch(() => this.failAll());
  }

  private async load(url: string): Promise<void> {
    const metadata = waitFor(this.video, 'loadedmetadata');
    this.detach = await attachSource(this.video, url, 0);
    await metadata;
  }

  get frameRatio(): number {
    if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
      return this.video.videoWidth / this.video.videoHeight;
    }
    return 16 / 9;
  }

  /** A cached still near `seconds` of the wanted size (a large one serves small requests too). */
  cached(seconds: number, urgent: boolean): HTMLCanvasElement | undefined {
    const large = this.large.get(cacheKey(seconds));
    if (large !== undefined || urgent) {
      return large;
    }
    return this.small.get(cacheKey(seconds));
  }

  grab(seconds: number, urgent: boolean, owner?: object): Promise<HTMLCanvasElement | undefined> {
    const known = this.cached(seconds, urgent);
    if (known !== undefined) {
      return Promise.resolve(known);
    }
    return new Promise((resolve) => {
      if (urgent) {
        this.dropUrgent();
        this.queue.unshift({ seconds, urgent, owner, resolve });
      } else {
        this.queue.push({ seconds, urgent, owner, resolve });
      }
      void this.drain();
    });
  }

  /** Forgets the queued requests of `owner` (a filmstrip that moved on). */
  cancel(owner: object): void {
    const dropped = this.queue.filter((request) => request.owner === owner);
    this.queue = this.queue.filter((request) => request.owner !== owner);
    dropped.forEach((request) => request.resolve(undefined));
  }

  private dropUrgent(): void {
    const dropped = this.queue.filter((request) => request.urgent);
    this.queue = this.queue.filter((request) => !request.urgent);
    dropped.forEach((request) => request.resolve(undefined));
  }

  private async drain(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      await this.loaded;
      await this.drainQueue();
    } catch {
      this.failAll();
    } finally {
      this.busy = false;
    }
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0 && !this.closed) {
      const request = this.queue.shift() as GrabRequest;
      request.resolve(await this.stillAt(request.seconds, request.urgent));
    }
  }

  private async stillAt(seconds: number, urgent: boolean): Promise<HTMLCanvasElement> {
    const known = this.cached(seconds, urgent);
    if (known !== undefined) {
      return known;
    }
    const seeked = waitFor(this.video, 'seeked');
    this.video.currentTime = seconds;
    await seeked;
    if (urgent) {
      return remember(this.large, LARGE_CACHE_LIMIT, seconds, drawStill(this.video, LARGE_WIDTH));
    }
    return remember(this.small, SMALL_CACHE_LIMIT, seconds, drawStill(this.video, SMALL_WIDTH));
  }

  private failAll(): void {
    const failed = this.queue;
    this.queue = [];
    failed.forEach((request) => request.resolve(undefined));
  }

  close(): void {
    this.closed = true;
    this.failAll();
    this.detach?.();
  }
}

interface SharedGrabber {
  grabber: FrameGrabber;
  users: number;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

const grabbers = new Map<string, SharedGrabber>();

/** One grabber per video URL, shared by the preview and the filmstrip; call the result to let go. */
export function useGrabber(url: string): { grabber: FrameGrabber; release: () => void } {
  let shared = grabbers.get(url);
  if (shared === undefined) {
    shared = { grabber: new FrameGrabber(url), users: 0 };
    grabbers.set(url, shared);
  }
  clearTimeout(shared.releaseTimer);
  shared.users += 1;
  const entry = shared;
  return { grabber: entry.grabber, release: () => releaseGrabber(url, entry) };
}

function releaseGrabber(url: string, entry: SharedGrabber): void {
  entry.users -= 1;
  if (entry.users > 0) {
    return;
  }
  entry.releaseTimer = setTimeout(() => {
    entry.grabber.close();
    grabbers.delete(url);
  }, IDLE_RELEASE_MS);
}
