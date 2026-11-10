import type { Group, Suggestion, Taxonomy } from '@atlas/contracts';
import { isGroupActive } from '@atlas/contracts';
import type { Draft } from './draft';
import { valuesOfGroup } from './draft';

export const ACCEPT_THRESHOLD = 0.5;
/** Probabilities below this are noise and not drawn on chips. */
export const DISPLAY_THRESHOLD = 0.05;

/**
 * The project's prefill source if it pushed something for this item, else the newest push
 * (last in the list) that carries label probabilities; priority-only pushes have nothing to show.
 */
export function chooseSuggestion(suggestions: Suggestion[], prefillSource?: string): Suggestion | undefined {
  if (prefillSource !== undefined) {
    const preferred = suggestions.find((suggestion) => suggestion.source === prefillSource);
    if (preferred !== undefined) {
      return preferred;
    }
  }
  const withValues = suggestions.filter((suggestion) => suggestion.values !== undefined);
  if (withValues.length === 0) {
    return undefined;
  }
  return withValues[withValues.length - 1];
}

export function probabilityOf(suggestion: Suggestion | undefined, groupId: string, labelId: string): number | undefined {
  if (suggestion === undefined || suggestion.values === undefined) {
    return undefined;
  }
  const group = suggestion.values[groupId];
  if (group === undefined) {
    return undefined;
  }
  return group[labelId];
}

function proposedLabelIds(group: Group, suggestion: Suggestion, threshold: number): string[] {
  const candidates = group.labels
    .filter((label) => label.deprecated !== true)
    .map((label) => ({ id: label.id, probability: probabilityOf(suggestion, group.id, label.id) }))
    .filter((candidate) => candidate.probability !== undefined && candidate.probability >= threshold)
    .sort((left, right) => Number(right.probability) - Number(left.probability));
  if (group.kind === "single") {
    return candidates.slice(0, 1).map((candidate) => candidate.id);
  }
  return candidates.map((candidate) => candidate.id);
}

function isOpenToProposals(group: Group, draft: Draft): boolean {
  if (!isGroupActive(group, draft.values)) {
    return false;
  }
  if (group.primary !== true && !draft.moreExpanded) {
    return false;
  }
  return valuesOfGroup(draft, group.id).length === 0;
}

function acceptOnce(taxonomy: Taxonomy, draft: Draft, suggestion: Suggestion, threshold: number): Draft {
  const values = { ...draft.values };
  for (const group of taxonomy.groups) {
    if (!isOpenToProposals(group, { ...draft, values })) {
      continue;
    }
    const labelIds = proposedLabelIds(group, suggestion, threshold);
    if (labelIds.length > 0) {
      values[group.id] = labelIds;
    }
  }
  return { ...draft, values };
}

/**
 * Accepts the proposals at or above `threshold` in visible, active groups that are still empty;
 * a person's own choice is never overwritten. Accepting can open conditional groups, whose
 * proposals are taken too.
 */
export function acceptProposals(
  taxonomy: Taxonomy,
  draft: Draft,
  suggestion: Suggestion | undefined,
  threshold = ACCEPT_THRESHOLD,
): Draft {
  if (suggestion === undefined) {
    return draft;
  }
  let current = draft;
  for (let pass = 0; pass <= taxonomy.groups.length; pass++) {
    const next = acceptOnce(taxonomy, current, suggestion, threshold);
    if (JSON.stringify(next.values) === JSON.stringify(current.values)) {
      return current;
    }
    current = next;
  }
  return current;
}
