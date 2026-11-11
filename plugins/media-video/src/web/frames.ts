export const DEFAULT_FRAME_RATE = 30;
const MIN_FRAME_RATE = 5;
const MAX_FRAME_RATE = 240;
/** Presented frames to watch before trusting a measured rate. */
const SAMPLE_SIZE = 12;

/** Index of the frame showing at `seconds`; a hair of tolerance absorbs float error at frame edges. */
export function frameIndexAt(seconds: number, frameRate: number): number {
  return Math.floor(seconds * frameRate + 1e-3);
}

/**
 * The time to seek to for the frame `count` frames away from the one at `seconds`. It aims at the
 * middle of the target frame so decoders never round to its neighbour.
 */
export function frameStepTarget(seconds: number, count: number, frameRate: number): number {
  const target = frameIndexAt(seconds, frameRate) + count;
  return Math.max(0, (target + 0.5) / frameRate);
}

const COMMON_FRAME_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

/** Rounds a measured rate to the nearest common NTSC/PAL rate when it is within 1 % of one. */
export function snapFrameRate(measured: number): number {
  let nearest = Math.round(measured * 1000) / 1000;
  let nearestDistance = 0.01;
  for (const rate of COMMON_FRAME_RATES) {
    const distance = Math.abs(measured - rate) / rate;
    if (distance < nearestDistance) {
      nearest = rate;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/**
 * Watches media times of presented frames (requestVideoFrameCallback) and derives the rate from
 * the smallest step between consecutive frames; larger steps are dropped frames.
 */
export class FrameRateMeter {
  private previous: number | undefined;
  private steps: number[] = [];

  /** Feeds one presented frame; returns the rate once enough frames were seen. */
  observe(mediaTime: number): number | undefined {
    const previous = this.previous;
    this.previous = mediaTime;
    if (previous === undefined) {
      return undefined;
    }
    const step = mediaTime - previous;
    if (step > 1 / MAX_FRAME_RATE && step < 1 / MIN_FRAME_RATE) {
      this.steps.push(step);
    }
    if (this.steps.length < SAMPLE_SIZE) {
      return undefined;
    }
    return snapFrameRate(1 / Math.min(...this.steps));
  }

  /** Seeks break the sequence of frames. */
  reset(): void {
    this.previous = undefined;
  }
}
