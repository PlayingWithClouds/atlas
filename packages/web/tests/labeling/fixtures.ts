import type { Taxonomy } from '@atlas/contracts';

/** position (single, primary) -> pose (conditional on standing); activity (multi, primary); extras (multi, behind "more"). */
export const taxonomy: Taxonomy = {
  version: 3,
  groups: [
    {
      id: 'position',
      label: 'Position',
      kind: 'single',
      primary: true,
      labels: [
        { id: 'standing', name: 'Standing', hotkey: 'x' },
        { id: 'sitting', name: 'Sitting', hotkey: 'y' },
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
