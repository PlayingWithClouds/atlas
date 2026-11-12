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
  return attachHlsJs(video, url, startSeconds);
}

async function attachHlsJs(video: HTMLVideoElement, url: string, startSeconds: number): Promise<DetachSource> {
  const { default: HlsClass } = await import('hls.js');
  if (!HlsClass.isSupported()) {
    throw new Error('This browser cannot play HLS streams');
  }
  const hls = new HlsClass({ startPosition: startSeconds });
  hls.loadSource(url);
  hls.attachMedia(video);
  return detachHls(hls, video);
}

function isUnsupportedSource(video: HTMLVideoElement): boolean {
  return video.error !== null && video.error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
}

/**
 * A progressive source that may turn out to be an HLS playlist (an adapter's URL can redirect to
 * either, and the stream behind it can change): when the browser cannot play it, hls.js gets a try.
 */
function attachProgressiveWithFallback(video: HTMLVideoElement, url: string, startSeconds: number): DetachSource {
  let detach = attachProgressive(video, url);
  let detached = false;
  const onError = () => {
    if (!isUnsupportedSource(video)) {
      return;
    }
    video.removeEventListener('error', onError);
    detach();
    void attachHlsJs(video, url, startSeconds).then((detachFallback) => {
      if (detached) {
        detachFallback();
        return;
      }
      detach = detachFallback;
    });
  };
  video.addEventListener('error', onError);
  return () => {
    detached = true;
    video.removeEventListener('error', onError);
    detach();
  };
}

/**
 * Points a <video> at `url`: progressive files (served with Range) go straight in, `.m3u8`
 * playlists go through hls.js unless the browser plays them natively. A progressive URL the
 * browser cannot play is retried as HLS.
 */
export async function attachSource(video: HTMLVideoElement, url: string, startSeconds: number): Promise<DetachSource> {
  if (isHlsUrl(url)) {
    return attachHls(video, url, startSeconds);
  }
  return attachProgressiveWithFallback(video, url, startSeconds);
}
