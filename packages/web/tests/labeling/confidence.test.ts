import { describe, expect, test } from 'bun:test';
import type { FrameConfidence } from '@atlas/contracts';
import { confidenceColor, confidenceStrip, labelTracks, likelyLabels } from '../../src/core/labeling/timeline';
import { taxonomy } from './fixtures';

const confidence: FrameConfidence = {
  times: [0, 1, 2, 3],
  values: {
    activity: { talking: [0.1, 0.9, 0.95, 0.2], dancing: [0, 0.05, 0.1, 0] },
    extras: { hat: [0.4, 0.2, 0.1, 0] },
  },
};

describe('confidence view', () => {
  test('labels likely somewhere are listed, the others not', () => {
    expect(likelyLabels(confidence, 0.3)).toEqual([
      { group: 'activity', label: 'talking' },
      { group: 'extras', label: 'hat' },
    ]);
  });

  test('a likely label gets a track with nothing on it', () => {
    const tracks = labelTracks({
      groups: taxonomy.groups,
      values: {},
      ranges: [],
      suggested: [],
      shown: [{ group: 'activity', label: 'talking' }],
    });
    expect(tracks.map((track) => `${track.group.id}.${track.label.id}`)).toEqual(['activity.talking']);
  });

  test('the strip spans every frame and runs red to green', () => {
    const strip = confidenceStrip(confidence, { group: 'activity', label: 'talking' });
    expect(strip?.start).toBe(0);
    expect(strip?.end).toBe(4);
    expect(strip?.gradient).toContain(`${confidenceColor(0.9)} 37.500%`);
    expect(confidenceColor(0)).toBe('hsl(0 75% 45%)');
    expect(confidenceColor(1)).toBe('hsl(120 75% 45%)');
  });

  test('no strip for a label the answer does not have', () => {
    expect(confidenceStrip(confidence, { group: 'position', label: 'sitting' })).toBeUndefined();
  });
});
