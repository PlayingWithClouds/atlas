import { describe, expect, test } from 'bun:test';
import { formatTime, isOutside, loopTarget, nextPlaybackRate } from '../../src/web/loopWindow';
import { isHlsUrl } from '../../src/web/source';

const window = { start: 10, end: 20 };

describe('looping a span', () => {
  test('jumps back to the start once the end is reached', () => {
    expect(loopTarget(20, window, false)).toBe(10);
    expect(loopTarget(25, window, false)).toBe(10);
  });

  test('keeps playing inside the span', () => {
    expect(loopTarget(10, window, false)).toBeUndefined();
    expect(loopTarget(19.9, window, false)).toBeUndefined();
    expect(isOutside(9.96, window)).toBe(false);
  });

  test('pulls a playhead from before the span back to its start', () => {
    expect(loopTarget(8, window, false)).toBe(10);
  });

  test('leaves a deliberate seek outside the span alone', () => {
    expect(loopTarget(25, window, true)).toBeUndefined();
  });

  test('has nothing to loop without a span', () => {
    expect(loopTarget(99, undefined, false)).toBeUndefined();
  });
});

describe('player controls', () => {
  test('cycles playback rates and recovers from unknown ones', () => {
    expect(nextPlaybackRate(1)).toBe(1.5);
    expect(nextPlaybackRate(2)).toBe(0.25);
    expect(nextPlaybackRate(3)).toBe(1);
  });

  test('formats time with a tenth of a second', () => {
    expect(formatTime(0)).toBe('0:00.0');
    expect(formatTime(75.34)).toBe('1:15.3');
    expect(formatTime(-4)).toBe('0:00.0');
  });
});

describe('source kinds', () => {
  test('recognises HLS playlists, also with a query string', () => {
    expect(isHlsUrl('https://cdn.example/stream/index.m3u8')).toBe(true);
    expect(isHlsUrl('https://cdn.example/stream/index.M3U8?token=abc')).toBe(true);
    expect(isHlsUrl('https://cdn.example/clip.mp4')).toBe(false);
    expect(isHlsUrl('https://cdn.example/m3u8/clip.mp4')).toBe(false);
  });
});
