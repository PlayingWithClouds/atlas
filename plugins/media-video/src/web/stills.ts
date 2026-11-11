import type { Asset } from '@atlas/contracts';
import { useGrabber } from './frameGrabber';
import type { FrameGrabber } from './frameGrabber';
import { cueAt, loadThumbnailTrack } from './thumbnails';
import type { ThumbnailCue } from './thumbnails';

/** A picture to draw: part of an image (a sprite tile) or a whole grabbed frame. */
export interface Still {
  image: CanvasImageSource;
  x: number;
  y: number;
  width: number;
  height: number;
}

const images = new Map<string, Promise<HTMLImageElement | undefined>>();

function loadImage(url: string): Promise<HTMLImageElement | undefined> {
  const known = images.get(url);
  if (known !== undefined) {
    return known;
  }
  const loading = new Promise<HTMLImageElement | undefined>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(undefined);
    image.src = url;
  });
  images.set(url, loading);
  return loading;
}

async function stillOfCue(cue: ThumbnailCue): Promise<Still | undefined> {
  const image = await loadImage(cue.image);
  if (image === undefined) {
    return undefined;
  }
  if (cue.tile !== undefined) {
    return { image, ...cue.tile };
  }
  return { image, x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
}

function wholeCanvas(canvas: HTMLCanvasElement | undefined): Still | undefined {
  if (canvas === undefined) {
    return undefined;
  }
  return { image: canvas, x: 0, y: 0, width: canvas.width, height: canvas.height };
}

/** Median gap between thumbnail-track stills. */
function spacingOf(cues: ThumbnailCue[]): number {
  if (cues.length === 0) {
    return Infinity;
  }
  const lengths = cues.map((cue) => cue.end - cue.start).sort((first, second) => first - second);
  return lengths[Math.floor(lengths.length / 2)];
}

/**
 * Stills of one video for the timeline: quick ones from the asset's thumbnail track (a sprite,
 * instant but coarse) and exact ones grabbed from the video itself (one seek each).
 */
export class Stills {
  private readonly cues: Promise<ThumbnailCue[]>;
  private shared: { grabber: FrameGrabber; release: () => void } | undefined;
  private released = false;

  constructor(private readonly asset: Asset) {
    if (asset.thumbnails === undefined) {
      this.cues = Promise.resolve([]);
      return;
    }
    this.cues = loadThumbnailTrack(asset.thumbnails);
  }

  /** The track's still nearest `seconds`; undefined without a track. */
  async quick(seconds: number): Promise<Still | undefined> {
    const cue = cueAt(await this.cues, seconds);
    if (cue === undefined) {
      return undefined;
    }
    return stillOfCue(cue);
  }

  /** Seconds between the track's stills; Infinity without a track. */
  async spacing(): Promise<number> {
    return spacingOf(await this.cues);
  }

  /** The frame at `seconds`, grabbed from the video; urgent requests jump the queue. */
  async exact(seconds: number, urgent: boolean, owner?: object): Promise<Still | undefined> {
    const grabber = this.grabber();
    if (grabber === undefined) {
      return undefined;
    }
    return wholeCanvas(await grabber.grab(seconds, urgent, owner));
  }

  private grabber(): FrameGrabber | undefined {
    if (this.released) {
      return undefined;
    }
    if (this.shared === undefined) {
      this.shared = useGrabber(this.asset.url);
    }
    return this.shared.grabber;
  }

  cancel(owner: object): void {
    this.shared?.grabber.cancel(owner);
  }

  release(): void {
    this.released = true;
    this.shared?.release();
  }
}

/** Draws a still into a canvas, letterboxed, at the canvas's on-screen size. */
export function paintStill(canvas: HTMLCanvasElement, still: Still): void {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  if (context === null) {
    return;
  }
  const scale = Math.min(width / still.width, height / still.height);
  const drawnWidth = still.width * scale;
  const drawnHeight = still.height * scale;
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  context.drawImage(still.image, still.x, still.y, still.width, still.height, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
}
