import { describe, expect, test } from 'bun:test';
import { FrameRateMeter, frameIndexAt, frameStepTarget, snapFrameRate } from '../../src/web/frames';
import { cueAt, parseThumbnailTrack, parseTimestamp } from '../../src/web/thumbnails';

describe('frame stepping', () => {
  test('aims at the middle of the neighbouring frame', () => {
    expect(frameIndexAt(1, 25)).toBe(25);
    expect(frameIndexAt(0.9999999, 25)).toBe(25);
    expect(frameStepTarget(1, 1, 25)).toBeCloseTo(26.5 / 25);
    expect(frameStepTarget(1, -1, 25)).toBeCloseTo(24.5 / 25);
    expect(frameStepTarget(0, -5, 25)).toBe(0);
  });

  test('stepping from a step lands on the next frame, not the same one', () => {
    const once = frameStepTarget(10, 1, 30);
    const twice = frameStepTarget(once, 1, 30);
    expect(frameIndexAt(twice, 30) - frameIndexAt(once, 30)).toBe(1);
  });

  test('measures the rate from presented frames, ignoring dropped ones', () => {
    const meter = new FrameRateMeter();
    let rate: number | undefined;
    let time = 0;
    for (let frame = 0; frame < 20 && rate === undefined; frame++) {
      time += frame % 5 === 4 ? 2 / 25 : 1 / 25;
      rate = meter.observe(time);
    }
    expect(rate).toBe(25);
  });

  test('snaps to common rates', () => {
    expect(snapFrameRate(29.968)).toBe(29.97);
    expect(snapFrameRate(23.98)).toBe(23.976);
    expect(snapFrameRate(30.001)).toBe(30);
    expect(snapFrameRate(17.5)).toBe(17.5);
  });
});

describe('thumbnail tracks', () => {
  const track = [
    'WEBVTT',
    '',
    '00:00.000 --> 00:05.000',
    'sprite.jpg#xywh=0,0,160,90',
    '',
    '00:05.000 --> 00:10.000',
    'sprite.jpg#xywh=160,0,160,90',
    '',
    '1',
    '00:00:10.000 --> 00:00:15.000',
    'https://cdn.example/still-3.jpg',
  ].join('\n');

  test('parses timestamps with and without hours', () => {
    expect(parseTimestamp('01:02.5')).toBe(62.5);
    expect(parseTimestamp('1:00:02.000')).toBe(3602);
  });

  test('parses sprite tiles and whole images, resolving relative URLs', () => {
    const cues = parseThumbnailTrack(track, 'http://media.local/thumbs/video.vtt');
    expect(cues).toHaveLength(3);
    expect(cues[1]).toEqual({
      start: 5,
      end: 10,
      image: 'http://media.local/thumbs/sprite.jpg',
      tile: { x: 160, y: 0, width: 160, height: 90 },
    });
    expect(cues[2].image).toBe('https://cdn.example/still-3.jpg');
    expect(cues[2].tile).toBeUndefined();
  });

  test('finds the cue at a time, else the nearest', () => {
    const cues = parseThumbnailTrack(track, 'http://media.local/video.vtt');
    expect(cueAt(cues, 7)?.start).toBe(5);
    expect(cueAt(cues, 99)?.start).toBe(10);
    expect(cueAt([], 3)).toBeUndefined();
  });
});
