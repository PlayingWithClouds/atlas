import type Hls from 'hls.js';

/** Detaches a source and frees its decoder and connections. */
export type DetachSource = () => void;

export function isHlsUrl(url: string): boolean {
  const path = url.split(/[?#]/)[0];
  return path.toLowerCase().endsWith('.m3u8');
}

function attachProgressive(video: HTMLVideoElement, url: string): DetachSource {
  video.src = url;
  return () => {
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
}

function nativeHlsSupported(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

function detachHls(hls: Hls, video: HTMLVideoElement): DetachSource {
  return () => {
    hls.destroy();
    video.removeAttribute('src');
    video.load();
  };
}

async function attachHls(video: HTMLVideoElement, url: string, startSeconds: number): Promise<DetachSource> {
  if (nativeHlsSupported(video)) {
    return attachProgressive(video, url);
  }
  const { default: HlsClass } = await import('hls.js');
  if (!HlsClass.isSupported()) {
    throw new Error('This browser cannot play HLS streams');
  }
  const hls = new HlsClass({ startPosition: startSeconds });
  hls.loadSource(url);
  hls.attachMedia(video);
  return detachHls(hls, video);
}

/**
 * Points a <video> at `url`: progressive files (served with Range) go straight in, `.m3u8`
 * playlists go through hls.js unless the browser plays them natively.
 */
export async function attachSource(video: HTMLVideoElement, url: string, startSeconds: number): Promise<DetachSource> {
  if (isHlsUrl(url)) {
    return attachHls(video, url, startSeconds);
  }
  return attachProgressive(video, url);
}
