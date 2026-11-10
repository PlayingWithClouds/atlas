export interface LoopWindow {
  start: number;
  end: number;
}

/** How far before the window the playhead may be before it counts as outside. */
const OUTSIDE_TOLERANCE_SECONDS = 0.05;

export function isOutside(seconds: number, window: LoopWindow): boolean {
  return seconds < window.start - OUTSIDE_TOLERANCE_SECONDS || seconds >= window.end;
}

/**
 * Where playback must jump to stay inside the window, or undefined to carry on. While the person
 * has deliberately gone outside (to trim beyond the item), nothing pulls the playhead back until
 * it re-enters the window.
 */
export function loopTarget(seconds: number, window: LoopWindow | undefined, roaming: boolean): number | undefined {
  if (window === undefined || roaming) {
    return undefined;
  }
  if (isOutside(seconds, window)) {
    return window.start;
  }
  return undefined;
}

/** `m:ss.s` for the control bar. */
export function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = (safe - minutes * 60).toFixed(1).padStart(4, '0');
  return `${minutes}:${rest}`;
}

export const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2];

/** The rate after `rate` in the cycle; unknown rates restart at normal speed. */
export function nextPlaybackRate(rate: number): number {
  const index = PLAYBACK_RATES.indexOf(rate);
  if (index === -1) {
    return 1;
  }
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
}
