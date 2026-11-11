/**
 * Pure checks of the schema rules, shared by the server (enforced on save) and the web app
 * (shown before saving). Each check returns human-readable problems; empty means valid.
 */

import type { AnnotationInput, Group, Item, Range, Span, Taxonomy } from "./schema";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

// --- taxonomy ----------------------------------------------------------------------------

export function validateTaxonomy(taxonomy: Pick<Taxonomy, "groups">): string[] {
  const problems: string[] = [];
  const groupIds = new Set<string>();
  for (const group of taxonomy.groups) {
    if (groupIds.has(group.id)) {
      problems.push(`group "${group.id}" is defined twice`);
    }
    groupIds.add(group.id);
    problems.push(...validateGroup(group));
  }
  for (const group of taxonomy.groups) {
    problems.push(...validateCondition(group, taxonomy.groups));
  }
  return problems;
}

function validateGroup(group: Group): string[] {
  const problems: string[] = [];
  if (!ID_PATTERN.test(group.id)) {
    problems.push(`group id "${group.id}" must be lowercase letters, digits, "_" or "-"`);
  }
  if (group.kind !== "single" && group.kind !== "multi") {
    problems.push(`group "${group.id}" has unknown kind "${String(group.kind)}"`);
  }
  const labelIds = new Set<string>();
  const hotkeys = new Set<string>();
  for (const label of group.labels) {
    if (!ID_PATTERN.test(label.id)) {
      problems.push(`label id "${group.id}.${label.id}" must be lowercase letters, digits, "_" or "-"`);
    }
    if (labelIds.has(label.id)) {
      problems.push(`label "${group.id}.${label.id}" is defined twice`);
    }
    labelIds.add(label.id);
    if (label.hotkey === undefined) {
      continue;
    }
    if (label.hotkey.length !== 1) {
      problems.push(`hotkey of "${group.id}.${label.id}" must be one character`);
    }
    if (hotkeys.has(label.hotkey)) {
      problems.push(`hotkey "${label.hotkey}" is used twice in group "${group.id}"`);
    }
    hotkeys.add(label.hotkey);
  }
  return problems;
}

function validateCondition(group: Group, groups: Group[]): string[] {
  if (group.when === undefined) {
    return [];
  }
  const target = groups.find((candidate) => candidate.id === group.when?.group);
  if (target === undefined) {
    return [`group "${group.id}" depends on unknown group "${group.when.group}"`];
  }
  if (target.when !== undefined) {
    return [`group "${group.id}" depends on "${target.id}", which has a condition itself`];
  }
  if (!target.labels.some((label) => label.id === group.when?.label)) {
    return [`group "${group.id}" depends on unknown label "${group.when.group}.${group.when.label}"`];
  }
  return [];
}

/** Ids that a new taxonomy may not drop: every group and label of the old one stays (deprecate instead). */
export function removedIds(previous: Pick<Taxonomy, "groups">, next: Pick<Taxonomy, "groups">): string[] {
  const nextIds = new Set(allIds(next));
  return allIds(previous).filter((id) => !nextIds.has(id));
}

function allIds(taxonomy: Pick<Taxonomy, "groups">): string[] {
  const ids: string[] = [];
  for (const group of taxonomy.groups) {
    ids.push(group.id);
    for (const label of group.labels) {
      ids.push(`${group.id}.${label.id}`);
    }
  }
  return ids;
}

// --- conditions --------------------------------------------------------------------------

/** Whether a group is asked, given the labels that hold for the whole item. */
/** Whether a group is asked: no condition, or its condition label is on for the whole item or in a range. */
export function isGroupActive(group: Group, values: Record<string, string[]>, ranges: Range[] = []): boolean {
  const condition = group.when;
  if (condition === undefined) {
    return true;
  }
  const chosen = values[condition.group];
  if (chosen !== undefined && chosen.includes(condition.label)) {
    return true;
  }
  return ranges.some((range) => range.group === condition.group && range.label === condition.label);
}

// --- annotations -------------------------------------------------------------------------

/** Length of an item in seconds, or undefined when unknown (whole asset of unknown duration). */
export function itemLength(item: Item, assetDuration?: number): number | undefined {
  if (item.span !== undefined) {
    return item.span.end - item.span.start;
  }
  return assetDuration;
}

export function validateAnnotation(taxonomy: Taxonomy, input: AnnotationInput, length?: number): string[] {
  if (input.status === "skipped") {
    return validateSkipped(input);
  }
  const problems: string[] = [];
  for (const [groupId, labelIds] of Object.entries(input.values)) {
    problems.push(...validateValues(taxonomy, groupId, labelIds));
  }
  for (const range of rangesOf(input)) {
    problems.push(...validateRange(taxonomy, range, length));
  }
  problems.push(...validateSingleRanges(taxonomy, rangesOf(input)));
  problems.push(...validateReviewed(taxonomy, input));
  if (input.span !== undefined) {
    problems.push(...validateSpan(input.span));
  }
  return problems;
}

function rangesOf(input: AnnotationInput): Range[] {
  if (input.ranges === undefined) {
    return [];
  }
  return input.ranges;
}

function valuesOf(input: AnnotationInput, groupId: string): string[] {
  const labelIds = input.values[groupId];
  if (labelIds === undefined) {
    return [];
  }
  return labelIds;
}

function validateSkipped(input: AnnotationInput): string[] {
  const hasValues = Object.values(input.values).some((labelIds) => labelIds.length > 0);
  const hasRanges = rangesOf(input).length > 0;
  if (hasValues || hasRanges || input.reviewed.length > 0) {
    return ["a skipped item has no values, ranges or reviewed groups"];
  }
  return [];
}

function findGroup(taxonomy: Taxonomy, groupId: string): Group | undefined {
  return taxonomy.groups.find((group) => group.id === groupId);
}

function validateValues(taxonomy: Taxonomy, groupId: string, labelIds: string[]): string[] {
  const group = findGroup(taxonomy, groupId);
  if (group === undefined) {
    return [`unknown group "${groupId}"`];
  }
  const problems = labelIds
    .filter((labelId) => !group.labels.some((label) => label.id === labelId))
    .map((labelId) => `unknown label "${groupId}.${labelId}"`);
  if (group.kind === "single" && labelIds.length > 1) {
    problems.push(`group "${groupId}" takes one label, got ${labelIds.length}`);
  }
  if (new Set(labelIds).size !== labelIds.length) {
    problems.push(`group "${groupId}" lists a label twice`);
  }
  return problems;
}

function validateRange(taxonomy: Taxonomy, range: Range, length?: number): string[] {
  const group = findGroup(taxonomy, range.group);
  if (group === undefined) {
    return [`range uses unknown group "${range.group}"`];
  }
  if (!group.labels.some((label) => label.id === range.label)) {
    return [`range uses unknown label "${range.group}.${range.label}"`];
  }
  if (!(range.start >= 0 && range.start < range.end)) {
    return [`range "${range.group}.${range.label}" needs 0 ≤ start < end`];
  }
  if (length !== undefined && range.end > length + 1e-3) {
    return [`range "${range.group}.${range.label}" ends after the item (${length.toFixed(2)} s)`];
  }
  return [];
}

function validateSingleRanges(taxonomy: Taxonomy, ranges: Range[]): string[] {
  const problems: string[] = [];
  for (const group of taxonomy.groups) {
    if (group.kind !== "single") {
      continue;
    }
    const sorted = ranges.filter((range) => range.group === group.id).sort((a, b) => a.start - b.start);
    for (let index = 1; index < sorted.length; index++) {
      if (sorted[index].start < sorted[index - 1].end) {
        problems.push(`ranges of single-choice group "${group.id}" overlap`);
        break;
      }
    }
  }
  return problems;
}

function validateReviewed(taxonomy: Taxonomy, input: AnnotationInput): string[] {
  const problems: string[] = [];
  for (const groupId of input.reviewed) {
    const group = findGroup(taxonomy, groupId);
    if (group === undefined) {
      problems.push(`reviewed lists unknown group "${groupId}"`);
      continue;
    }
    if (!isGroupActive(group, input.values, rangesOf(input))) {
      problems.push(`group "${groupId}" is reviewed but its condition is not met`);
    }
  }
  for (const group of taxonomy.groups) {
    problems.push(...validateInactiveGroup(group, input));
  }
  return problems;
}

/** A group whose condition is unmet carries nothing; a group with values or ranges counts as reviewed. */
function validateInactiveGroup(group: Group, input: AnnotationInput): string[] {
  const hasValues = valuesOf(input, group.id).length > 0;
  const hasRanges = rangesOf(input).some((range) => range.group === group.id);
  if (!hasValues && !hasRanges) {
    return [];
  }
  if (!isGroupActive(group, input.values, rangesOf(input))) {
    return [`group "${group.id}" has labels but its condition is not met`];
  }
  if (!input.reviewed.includes(group.id)) {
    return [`group "${group.id}" has labels but is not in reviewed`];
  }
  return [];
}

function validateSpan(span: Span): string[] {
  if (span.start >= 0 && span.start < span.end) {
    return [];
  }
  return ["trimmed span needs 0 ≤ start < end"];
}
