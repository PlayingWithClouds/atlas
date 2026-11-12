import { isGroupActive } from '@atlas/contracts';
import type { Group, Range, Suggestion, Taxonomy } from '@atlas/contracts';
import type { Draft } from './draft';
import { valuesOfGroup } from './draft';

/**
 * Live suggestions: while a scene is open, the adapter's live endpoint is asked (POST) for the
 * whole scene again after every edit, from a model fine-tuned on what the person has labeled.
 * Labels the model is very sure of are added to the draft on their own ("auto-added").
 */

/** What atlas added by itself, by key; anything the person changes stops matching and is theirs. */
export interface AutoAdded {
  values: Set<string>;
  ranges: Set<string>;
}

export function emptyAutoAdded(): AutoAdded {
  return { values: new Set(), ranges: new Set() };
}

export function valueKey(groupId: string, labelId: string): string {
  return `${groupId}\u0000${labelId}`;
}

export function rangeKey(range: Range): string {
  return `${range.group}\u0000${range.label}\u0000${range.start.toFixed(3)}\u0000${range.end.toFixed(3)}`;
}

/** The annotation the live endpoint learns from: only what the person labeled, never auto-added labels. */
export interface LiveAnnotation {
  values: Record<string, string[]>;
  ranges: Range[];
  /** Only groups the person put a label in: a group left empty is unknown here, not "none". */
  reviewed: string[];
}

export function personsAnnotation(draft: Draft, autoAdded: AutoAdded): LiveAnnotation {
  const values: Record<string, string[]> = {};
  for (const [groupId, labelIds] of Object.entries(draft.values)) {
    const own = labelIds.filter((labelId) => !autoAdded.values.has(valueKey(groupId, labelId)));
    if (own.length > 0) {
      values[groupId] = own;
    }
  }
  const ranges = draft.ranges.filter((range) => !autoAdded.ranges.has(rangeKey(range)));
  const reviewed = new Set([...Object.keys(values), ...ranges.map((range) => range.group)]);
  return { values, ranges, reviewed: [...reviewed] };
}

/** What to add on its own: labels at or above `threshold` that nothing in the draft contradicts. */
export interface ConfidentAdditions {
  values: { group: Group; label: string }[];
  ranges: Range[];
}

/**
 * `offered` holds the keys of everything auto-added before on this item: what the person removed
 * again is not brought back.
 */
export function confidentAdditions(
  taxonomy: Taxonomy,
  draft: Draft,
  suggestion: Suggestion,
  threshold: number,
  offered: AutoAdded,
): ConfidentAdditions {
  return {
    values: confidentValues(taxonomy, draft, suggestion, threshold, offered),
    ranges: confidentRanges(taxonomy, draft, suggestion, threshold, offered),
  };
}

function confidentValues(
  taxonomy: Taxonomy,
  draft: Draft,
  suggestion: Suggestion,
  threshold: number,
  offered: AutoAdded,
): { group: Group; label: string }[] {
  const additions: { group: Group; label: string }[] = [];
  for (const group of askableGroups(taxonomy, draft)) {
    const probabilities = suggestion.values?.[group.id];
    if (probabilities === undefined) {
      continue;
    }
    for (const [labelId, probability] of Object.entries(probabilities)) {
      if (probability < threshold || offered.values.has(valueKey(group.id, labelId))) {
        continue;
      }
      if (valueFits(group, draft, labelId)) {
        additions.push({ group, label: labelId });
      }
    }
  }
  return additions;
}

/** A whole-scene value fits when the label is not set yet and, for a single group, nothing else is. */
function valueFits(group: Group, draft: Draft, labelId: string): boolean {
  if (!group.labels.some((label) => label.id === labelId && label.deprecated !== true)) {
    return false;
  }
  if (valuesOfGroup(draft, group.id).includes(labelId)) {
    return false;
  }
  if (draft.ranges.some((range) => range.group === group.id && range.label === labelId)) {
    return false;
  }
  if (group.kind === 'multi') {
    return true;
  }
  return valuesOfGroup(draft, group.id).length === 0 && !draft.ranges.some((range) => range.group === group.id);
}

function confidentRanges(
  taxonomy: Taxonomy,
  draft: Draft,
  suggestion: Suggestion,
  threshold: number,
  offered: AutoAdded,
): Range[] {
  const groups = askableGroups(taxonomy, draft);
  const additions: Range[] = [];
  for (const suggested of suggestion.ranges || []) {
    const group = groups.find((candidate) => candidate.id === suggested.group);
    if (group === undefined || suggested.score < threshold) {
      continue;
    }
    const range = { group: suggested.group, label: suggested.label, start: suggested.start, end: suggested.end };
    if (wasOfferedAround(range, offered) || !rangeFits(group, draft, range)) {
      continue;
    }
    additions.push(range);
  }
  return additions;
}

/** Ranges move a little between updates, so a removed auto-added range blocks its whole stretch. */
function wasOfferedAround(range: Range, offered: AutoAdded): boolean {
  for (const key of offered.ranges) {
    const [group, label, start, end] = key.split('\u0000');
    if (group === range.group && label === range.label && overlaps(range, Number(start), Number(end))) {
      return true;
    }
  }
  return false;
}

function rangeFits(group: Group, draft: Draft, range: Range): boolean {
  if (valuesOfGroup(draft, group.id).includes(range.label)) {
    return false;
  }
  const sameGroup = draft.ranges.filter((existing) => existing.group === group.id);
  if (group.kind === 'single') {
    return valuesOfGroup(draft, group.id).length === 0 && !sameGroup.some((existing) => overlaps(existing, range.start, range.end));
  }
  return !sameGroup.some((existing) => existing.label === range.label && overlaps(existing, range.start, range.end));
}

function overlaps(range: Range, start: number, end: number): boolean {
  return range.start < end && start < range.end;
}

/** Groups whose condition holds and that the person did not mark "not reviewed". */
function askableGroups(taxonomy: Taxonomy, draft: Draft): Group[] {
  return taxonomy.groups.filter(
    (group) => isGroupActive(group, draft.values, draft.ranges) && !draft.notReviewed.includes(group.id),
  );
}
