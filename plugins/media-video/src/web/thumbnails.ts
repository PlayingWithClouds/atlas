/** One cue of a WebVTT thumbnail track: an image, or a tile of a sprite sheet, for a stretch of time. */
export interface ThumbnailCue {
  start: number;
  end: number;
  /** Absolute image URL, without the `#xywh` fragment. */
  image: string;
  /** The tile inside the image; the whole image when absent. */
  tile?: { x: number; y: number; width: number; height: number };
}

const TIMING = /^\s*((?:\d+:)?\d+:\d+(?:\.\d+)?)\s+-->\s+((?:\d+:)?\d+:\d+(?:\.\d+)?)/;
const TILE = /#xywh=(\d+),(\d+),(\d+),(\d+)$/;

/** `hh:mm:ss.ttt` or `mm:ss.ttt` in seconds. */
export function parseTimestamp(text: string): number {
  return text
    .split(':')
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);
}

function tileOf(reference: string): ThumbnailCue['tile'] {
  const match = TILE.exec(reference);
  if (match === null) {
    return undefined;
  }
  return { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
}

function cueOf(timing: RegExpExecArray, reference: string, trackUrl: string): ThumbnailCue {
  const image = new URL(reference.replace(TILE, ''), trackUrl).toString();
  return { start: parseTimestamp(timing[1]), end: parseTimestamp(timing[2]), image, tile: tileOf(reference) };
}

/** Cues in file order; image references resolve against the track's own URL. */
export function parseThumbnailTrack(text: string, trackUrl: string): ThumbnailCue[] {
  const cues: ThumbnailCue[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const timing = TIMING.exec(lines[index]);
    const reference = lines[index + 1];
    if (timing === null || reference === undefined || reference.trim() === '') {
      continue;
    }
    cues.push(cueOf(timing, reference.trim(), trackUrl));
  }
  return cues;
}

/** The cue showing `seconds`, else the nearest one (tracks often leave small gaps). */
export function cueAt(cues: ThumbnailCue[], seconds: number): ThumbnailCue | undefined {
  let nearest: ThumbnailCue | undefined;
  let nearestDistance = Infinity;
  for (const cue of cues) {
    if (seconds >= cue.start && seconds < cue.end) {
      return cue;
    }
    const distance = Math.min(Math.abs(seconds - cue.start), Math.abs(seconds - cue.end));
    if (distance < nearestDistance) {
      nearest = cue;
      nearestDistance = distance;
    }
  }
  return nearest;
}

const tracks = new Map<string, Promise<ThumbnailCue[]>>();

/** Fetches and parses a track once per page; a failed fetch yields no cues (the grabber takes over). */
export function loadThumbnailTrack(url: string): Promise<ThumbnailCue[]> {
  const known = tracks.get(url);
  if (known !== undefined) {
    return known;
  }
  const loading = fetch(url)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`thumbnail track: ${response.status}`);
      }
      return response.text();
    })
    .then((text) => parseThumbnailTrack(text, url))
    .catch(() => []);
  tracks.set(url, loading);
  return loading;
}
