import { attachSource } from './source';
import type { DetachSource } from './source';

/** Width of grabbed stills; the timeline preview shows them at most this wide. */
const STILL_WIDTH = 384;
/** Stills are cached per this many seconds. */
const CACHE_STEP_SECONDS = 0.1;
const CACHE_LIMIT = 160;
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

function drawStill(video: HTMLVideoElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  let aspect = 16 / 9;
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    aspect = video.videoWidth / video.videoHeight;
  }
  canvas.width = STILL_WIDTH;
  canvas.height = Math.round(STILL_WIDTH / aspect);
  const context = canvas.getContext('2d');
  // A cross-origin video taints the canvas: it still displays, pixels just can't be read back.
  context?.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Grabs stills from a video with its own hidden <video> element, one seek at a time. Urgent
 * requests (the hover preview) jump the queue and replace each other: only the latest matters.
 */
export class FrameGrabber {
  private readonly video = document.createElement('video');
  private readonly cache = new Map<number, HTMLCanvasElement>();
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

  /** A cached still near `seconds`, without waiting. */
  cached(seconds: number): HTMLCanvasElement | undefined {
    return this.cache.get(cacheKey(seconds));
  }

  grab(seconds: number, urgent: boolean, owner?: object): Promise<HTMLCanvasElement | undefined> {
    const known = this.cached(seconds);
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
      request.resolve(await this.stillAt(request.seconds));
    }
  }

  private async stillAt(seconds: number): Promise<HTMLCanvasElement> {
    const known = this.cached(seconds);
    if (known !== undefined) {
      return known;
    }
    const seeked = waitFor(this.video, 'seeked');
    this.video.currentTime = seconds;
    await seeked;
    const still = drawStill(this.video);
    this.remember(seconds, still);
    return still;
  }

  private remember(seconds: number, still: HTMLCanvasElement): void {
    this.cache.set(cacheKey(seconds), still);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value as number;
      this.cache.delete(oldest);
    }
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
