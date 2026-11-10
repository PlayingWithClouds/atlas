import type { Asset, Item, Suggestion, Taxonomy } from '@atlas/contracts';

export const PROJECT_ID = 'scenes';

export const taxonomy: Taxonomy = {
  version: 1,
  groups: [
    {
      id: 'position',
      label: 'Position',
      kind: 'single',
      primary: true,
      labels: [
        { id: 'standing', name: 'Standing', hotkey: 'x' },
        { id: 'sitting', name: 'Sitting', hotkey: 'y' },
        { id: 'lying', name: 'Lying', hotkey: 'l' },
      ],
    },
    {
      id: 'pose',
      label: 'Pose',
      kind: 'single',
      primary: true,
      when: { group: 'position', label: 'standing' },
      labels: [
        { id: 'arms-up', name: 'Arms up' },
        { id: 'arms-down', name: 'Arms down' },
      ],
    },
    {
      id: 'activity',
      label: 'Activity',
      kind: 'multi',
      primary: true,
      labels: [
        { id: 'talking', name: 'Talking', hotkey: 't' },
        { id: 'dancing', name: 'Dancing', hotkey: 'd' },
        { id: 'eating', name: 'Eating', hotkey: 'e' },
        { id: 'legacy', name: 'Legacy', deprecated: true },
      ],
    },
    {
      id: 'extras',
      label: 'Extras',
      kind: 'multi',
      labels: [
        { id: 'glasses', name: 'Glasses' },
        { id: 'hat', name: 'Hat' },
      ],
    },
  ],
};

export function buildAssets(mediaUrl: string): Asset[] {
  return [
    { id: 'demo:video:1', kind: 'video', url: `${mediaUrl}/sample.mp4`, poster: `${mediaUrl}/poster.png`, duration: 90, width: 640, height: 360, title: 'Sample video (progressive mp4)', meta: { source: 'fake', tags: ['a', 'b'] } },
    { id: 'demo:video:2', kind: 'video', url: `${mediaUrl}/hls/index.m3u8`, poster: `${mediaUrl}/poster.png`, duration: 90, title: 'Sample video (HLS)' },
    { id: 'demo:image:1', kind: 'image', url: `${mediaUrl}/poster.png`, title: 'Sample image', width: 640, height: 360 },
  ];
}

export function buildItems(): Item[] {
  const scenes: Item[] = [];
  for (let index = 0; index < 6; index++) {
    const start = index * 15;
    scenes.push({ id: `demo:video:1#t=${start},${start + 15}`, assetId: 'demo:video:1', span: { start, end: start + 15 } });
  }
  const hls: Item = { id: 'demo:video:2#t=30,45', assetId: 'demo:video:2', span: { start: 30, end: 45 } };
  return [...scenes, hls, { id: 'demo:image:1', assetId: 'demo:image:1' }];
}

export function buildSuggestions(): Suggestion[] {
  return [
    { itemId: 'demo:video:1#t=0,15', source: 'probe-1', priority: 0.9, values: { position: { standing: 0.8, sitting: 0.1 }, pose: { 'arms-up': 0.7 }, activity: { talking: 0.62, dancing: 0.2 } } },
    { itemId: 'demo:video:1#t=15,30', source: 'probe-1', priority: 0.5, values: { position: { sitting: 0.9 }, activity: { eating: 0.55 } } },
  ];
}
