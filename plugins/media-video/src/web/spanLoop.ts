import { untrack } from 'svelte';
import type { LoopWindow } from './loopWindow';
import { loopTarget } from './loopWindow';
import { attachSource } from './source';

export interface SpanLoopOptions {
  video: () => HTMLVideoElement | undefined;
  url: () => string;
  span: () => LoopWindow | undefined;
  /** Called with the playhead on every frame while playing and after seeks. */
  ontime?: (seconds: number) => void;
  onfail: (message: string) => void;
}

/**
 * Loads the source into the video and keeps playback inside the span: seeks to its start when the
 * metadata is in, and jumps back from its end on every frame (timeupdate is too coarse).
 */
/** How far from the span start a freshly loaded video may sit before it is moved there. */
const START_TOLERANCE_SECONDS = 0.25;

export class SpanLoop {
  roaming = false;
  private frame = 0;

  constructor(private readonly options: SpanLoopOptions) {}

  /** Starts loading; returns the cleanup. Call from an effect that reads the url and the video. */
  load(): (() => void) | undefined {
    const video = this.options.video();
    if (video === undefined) {
      return undefined;
    }
    const url = this.options.url();
    const start = untrack(() => this.windowStart());
    let detach: (() => void) | undefined;
    let cancelled = false;
    attachSource(video, url, start)
      .then((detacher) => {
        if (cancelled) {
          detacher();
          return;
        }
        detach = detacher;
      })
      .catch((failure: unknown) => this.options.onfail(String(failure)));
    return () => {
      cancelled = true;
      this.stop();
      if (detach !== undefined) {
        detach();
      }
    };
  }

  private windowStart(): number {
    const window = this.options.span();
    if (window === undefined) {
      return 0;
    }
    return window.start;
  }

  onLoadedMetadata(): void {
    const video = this.options.video();
    if (video === undefined) {
      return;
    }
    video.currentTime = this.windowStart();
    this.report();
  }

  /**
   * First decoded frame: some streams (HLS, slow seeks) settle at 0 instead of the requested
   * start; pull the playhead back to the span start unless the person already moved it.
   */
  onLoadedData(): void {
    const video = this.options.video();
    if (video === undefined || this.roaming || !video.paused) {
      return;
    }
    const start = this.windowStart();
    if (Math.abs(video.currentTime - start) > START_TOLERANCE_SECONDS) {
      video.currentTime = start;
    }
    this.report();
  }

  /** Pulls the playhead into a changed span (a new item, a trim) unless the person went outside on purpose. */
  onSpanChanged(): void {
    const video = this.options.video();
    if (video === undefined || video.readyState === 0) {
      return;
    }
    const target = loopTarget(video.currentTime, this.options.span(), this.roaming);
    if (target !== undefined) {
      video.currentTime = target;
    }
  }

  /** A person-made seek: leaving the span is allowed, coming back resumes looping. */
  seek(seconds: number): void {
    const video = this.options.video();
    if (video === undefined) {
      return;
    }
    video.currentTime = Math.max(0, seconds);
    this.roaming = loopTarget(video.currentTime, this.options.span(), false) !== undefined;
    this.options.ontime?.(video.currentTime);
  }

  start(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.tick());
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
  }

  private tick(): void {
    const video = this.options.video();
    if (video === undefined || video.paused) {
      return;
    }
    this.followPlayhead(video);
    this.frame = requestAnimationFrame(() => this.tick());
  }

  private followPlayhead(video: HTMLVideoElement): void {
    const window = this.options.span();
    if (this.roaming && window !== undefined && loopTarget(video.currentTime, window, false) === undefined) {
      this.roaming = false;
    }
    const target = loopTarget(video.currentTime, window, this.roaming);
    if (target !== undefined) {
      video.currentTime = target;
    }
    this.options.ontime?.(video.currentTime);
  }

  /** Reports the playhead after a seek or while paused. */
  report(): void {
    const video = this.options.video();
    if (video !== undefined) {
      this.options.ontime?.(video.currentTime);
    }
  }

  /** Whole-asset playback has no end to loop at; the element's own end does it. */
  onEnded(): void {
    const video = this.options.video();
    if (video === undefined) {
      return;
    }
    video.currentTime = this.windowStart();
    void video.play().catch(() => undefined);
  }
}
