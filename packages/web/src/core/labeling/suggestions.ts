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

/**
 * How unsure the suggestion is about one group, 0 (sure) to 1 (no idea); undefined without
 * probabilities for it. Single groups: entropy over the labels, normalized by its maximum.
 * Multi groups: the label closest to 0.5 decides; a mean would hide one coin-flip label among
 * many confident zeros.
 */
export function uncertaintyOf(suggestion: Suggestion | undefined, group: Group): number | undefined {
  if (suggestion === undefined || suggestion.values === undefined) {
    return undefined;
  }
  const probabilities = suggestion.values[group.id];
  if (probabilities === undefined) {
    return undefined;
  }
  const values = Object.values(probabilities);
  if (values.length === 0) {
    return undefined;
  }
  if (group.kind === "single" && values.length === 1) {
    return 0;
  }
  if (group.kind === "single") {
    return normalizedEntropy(values);
  }
  return Math.max(...values.map((probability) => 1 - Math.abs(2 * probability - 1)));
}

function normalizedEntropy(probabilities: number[]): number {
  const total = probabilities.reduce((sum, probability) => sum + probability, 0);
  if (total <= 0) {
    return 1;
  }
  let entropy = 0;
  for (const probability of probabilities) {
    const share = probability / total;
    if (share > 0) {
      entropy -= share * Math.log(share);
    }
  }
  return entropy / Math.log(probabilities.length);
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
  if (!isGroupActive(group, draft.values, draft.ranges)) {
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
