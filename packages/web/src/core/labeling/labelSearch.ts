import type { Group, Label, Taxonomy } from '@atlas/contracts';
import type { Draft } from './draft';
import { focusableGroups, offeredLabels } from './draft';

export interface LabelMatch {
  group: Group;
  label: Label;
}

export const MAX_MATCHES = 8;

/** Lower is better; undefined means no match. */
function rankOf(group: Group, label: Label, query: string): number | undefined {
  const name = label.name.toLowerCase();
  if (name.startsWith(query)) {
    return 0;
  }
  if (name.split(/[\s_-]+/).some((word) => word.startsWith(query))) {
    return 1;
  }
  if (name.includes(query) || label.id.toLowerCase().includes(query)) {
    return 2;
  }
  const description = label.description;
  if (description !== undefined && description.toLowerCase().includes(query)) {
    return 3;
  }
  if (group.label.toLowerCase().includes(query)) {
    return 4;
  }
  return undefined;
}

/**
 * Labels of every group that is asked right now (also those behind "More groups" and active
 * refinements), best match first, screen order within a rank.
 */
export function searchLabels(taxonomy: Taxonomy, draft: Draft, query: string): LabelMatch[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === '') {
    return [];
  }
  const ranked: (LabelMatch & { rank: number; order: number })[] = [];
  const groups = focusableGroups(taxonomy, { ...draft, moreExpanded: true });
  for (const group of groups) {
    for (const label of offeredLabels(group, draft)) {
      const rank = rankOf(group, label, normalized);
      if (rank === undefined) continue;
      ranked.push({ group, label, rank, order: ranked.length });
    }
  }
  ranked.sort((left, right) => left.rank - right.rank || left.order - right.order);
  return ranked.slice(0, MAX_MATCHES).map(({ group, label }) => ({ group, label }));
}
