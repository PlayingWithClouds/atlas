import { isGroupActive } from '@atlas/contracts';
import type { Annotation, AnnotationInput, AnnotationStatus, Group, Range, Span, Taxonomy } from '@atlas/contracts';

/** What the person has decided so far on the labeling screen. Immutable: every edit returns a new draft. */
export interface Draft {
  /** Group id → label ids that hold for the whole item. */
  values: Record<string, string[]>;
  ranges: Range[];
  /** The trimmed span in asset seconds; absent while the item's own span stands. */
  span?: Span;
  /** Groups the person marked "not reviewed" even though they are visible. */
  notReviewed: string[];
  /** Whether the "More groups" section is open. */
  moreExpanded: boolean;
}

export function emptyDraft(): Draft {
  return { values: {}, ranges: [], notReviewed: [], moreExpanded: false };
}

export function valuesOfGroup(draft: Draft, groupId: string): string[] {
  const labelIds = draft.values[groupId];
  if (labelIds === undefined) {
    return [];
  }
  return labelIds;
}

export function hasLabels(draft: Draft, groupId: string): boolean {
  if (valuesOfGroup(draft, groupId).length > 0) {
    return true;
  }
  return draft.ranges.some((range) => range.group === groupId);
}

function isVisible(group: Group, draft: Draft): boolean {
  return group.primary === true || draft.moreExpanded;
}

function isOffered(label: { deprecated?: boolean }, isSet: boolean): boolean {
  return label.deprecated !== true || isSet;
}

/** Labels of a group in the order shown; deprecated ones only while they are set. */
export function offeredLabels(group: Group, draft: Draft) {
  const setIds = valuesOfGroup(draft, group.id);
  return group.labels.filter((label) => isOffered(label, setIds.includes(label.id)));
}

/** A group whose labels are all deprecated and unused has nothing left to ask. */
function hasNothingToAsk(group: Group, draft: Draft): boolean {
  return offeredLabels(group, draft).length === 0;
}

export interface GroupLayout {
  primary: Group[];
  more: Group[];
}

/** Groups to show now: conditional ones only while active, others split into primary and "more". */
export function layoutGroups(taxonomy: Taxonomy, draft: Draft): GroupLayout {
  const layout: GroupLayout = { primary: [], more: [] };
  for (const group of taxonomy.groups) {
    if (!isGroupActive(group, draft.values, draft.ranges) || hasNothingToAsk(group, draft)) {
      continue;
    }
    if (group.primary === true) {
      layout.primary.push(group);
      continue;
    }
    layout.more.push(group);
  }
  return layout;
}

/** The groups ↑/↓ can move between, in screen order. */
export function focusableGroups(taxonomy: Taxonomy, draft: Draft): Group[] {
  const layout = layoutGroups(taxonomy, draft);
  if (draft.moreExpanded) {
    return [...layout.primary, ...layout.more];
  }
  return layout.primary;
}

// --- reviewed ----------------------------------------------------------------------------

/**
 * A group counts as reviewed when it is active and either carries labels or is visible (primary,
 * or "More groups" open) without the person marking it "not reviewed". Collapsed groups stay
 * unknown; a group with an unmet condition is never reviewed.
 */
export function isReviewed(group: Group, draft: Draft): boolean {
  if (!isGroupActive(group, draft.values, draft.ranges)) {
    return false;
  }
  if (hasLabels(draft, group.id)) {
    return true;
  }
  if (!isVisible(group, draft)) {
    return false;
  }
  return !draft.notReviewed.includes(group.id);
}

export function reviewedGroupIds(taxonomy: Taxonomy, draft: Draft): string[] {
  return taxonomy.groups.filter((group) => isReviewed(group, draft)).map((group) => group.id);
}

// --- editing -----------------------------------------------------------------------------

/** Removes everything that belongs to groups whose condition is no longer met. */
export function pruneInactive(taxonomy: Taxonomy, draft: Draft): Draft {
  const inactiveIds = taxonomy.groups.filter((group) => !isGroupActive(group, draft.values, draft.ranges)).map((group) => group.id);
  if (inactiveIds.length === 0) {
    return draft;
  }
  const values: Record<string, string[]> = {};
  for (const [groupId, labelIds] of Object.entries(draft.values)) {
    if (!inactiveIds.includes(groupId)) {
      values[groupId] = labelIds;
    }
  }
  return {
    ...draft,
    values,
    ranges: draft.ranges.filter((range) => !inactiveIds.includes(range.group)),
    notReviewed: draft.notReviewed.filter((groupId) => !inactiveIds.includes(groupId)),
  };
}

function withValues(draft: Draft, groupId: string, labelIds: string[]): Draft {
  const values = { ...draft.values };
  if (labelIds.length === 0) {
    delete values[groupId];
  } else {
    values[groupId] = labelIds;
  }
  return { ...draft, values };
}

function labelIdsAfterToggle(group: Group, current: string[], labelId: string): string[] {
  if (current.includes(labelId)) {
    return current.filter((candidate) => candidate !== labelId);
  }
  if (group.kind === "single") {
    return [labelId];
  }
  return [...current, labelId];
}

/** Single groups behave like radio buttons (selecting the set label clears it); multi groups toggle. */
export function toggleLabel(taxonomy: Taxonomy, draft: Draft, group: Group, labelId: string): Draft {
  const next = labelIdsAfterToggle(group, valuesOfGroup(draft, group.id), labelId);
  return pruneInactive(taxonomy, withValues(draft, group.id, next));
}

export function clearGroup(taxonomy: Taxonomy, draft: Draft, groupId: string): Draft {
  const cleared = withValues(draft, groupId, []);
  const ranges = cleared.ranges.filter((range) => range.group !== groupId);
  return pruneInactive(taxonomy, { ...cleared, ranges });
}

export function setNotReviewed(draft: Draft, groupId: string, notReviewed: boolean): Draft {
  const others = draft.notReviewed.filter((candidate) => candidate !== groupId);
  if (notReviewed) {
    return { ...draft, notReviewed: [...others, groupId] };
  }
  return { ...draft, notReviewed: others };
}

export function setMoreExpanded(draft: Draft, moreExpanded: boolean): Draft {
  return { ...draft, moreExpanded };
}

function limitToKind(group: Group, labelIds: string[]): string[] {
  if (group.kind === "single") {
    return labelIds.slice(0, 1);
  }
  return labelIds;
}

/** Takes over the labels of another annotation (the previous scene), dropping ids the taxonomy no longer has. */
export function copyValues(taxonomy: Taxonomy, draft: Draft, source: Record<string, string[]>): Draft {
  const values = { ...draft.values };
  for (const group of taxonomy.groups) {
    const labelIds = source[group.id];
    if (labelIds === undefined) {
      continue;
    }
    const known = labelIds.filter((labelId) => group.labels.some((label) => label.id === labelId));
    if (known.length > 0) {
      values[group.id] = limitToKind(group, known);
    }
  }
  return pruneInactive(taxonomy, { ...draft, values });
}

// --- annotation <-> draft ----------------------------------------------------------------

function rangesOfAnnotation(annotation: Annotation): Range[] {
  if (annotation.ranges === undefined) {
    return [];
  }
  return annotation.ranges;
}

function isOnScreenAtLoad(group: Group, annotation: Annotation, moreExpanded: boolean): boolean {
  if (!isGroupActive(group, annotation.values, rangesOfAnnotation(annotation))) {
    return false;
  }
  return group.primary === true || moreExpanded;
}

/** An existing annotation reopens with its groups reviewed; visible groups it did not review show as "not reviewed". */
export function draftFromAnnotation(taxonomy: Taxonomy, annotation: Annotation | undefined): Draft {
  if (annotation === undefined || annotation.status === "skipped") {
    return emptyDraft();
  }
  const moreExpanded = taxonomy.groups.some(
    (group) => group.primary !== true && annotation.reviewed.includes(group.id),
  );
  const notReviewed = taxonomy.groups
    .filter((group) => isOnScreenAtLoad(group, annotation, moreExpanded))
    .filter((group) => !annotation.reviewed.includes(group.id))
    .map((group) => group.id);
  return {
    values: structuredClone(annotation.values),
    ranges: structuredClone(rangesOfAnnotation(annotation)),
    span: annotation.span,
    notReviewed,
    moreExpanded,
  };
}

function nonEmptyValues(taxonomy: Taxonomy, draft: Draft): Record<string, string[]> {
  const values: Record<string, string[]> = {};
  for (const group of taxonomy.groups) {
    const labelIds = valuesOfGroup(draft, group.id);
    if (labelIds.length > 0) {
      values[group.id] = labelIds;
    }
  }
  return values;
}

/** What the server is sent; a skip carries nothing, as the schema demands. */
export function buildAnnotationInput(taxonomy: Taxonomy, draft: Draft, status: AnnotationStatus): AnnotationInput {
  if (status === "skipped") {
    return { status, values: {}, reviewed: [] };
  }
  const input: AnnotationInput = {
    status,
    values: nonEmptyValues(taxonomy, draft),
    reviewed: reviewedGroupIds(taxonomy, draft),
  };
  if (draft.ranges.length > 0) {
    input.ranges = draft.ranges;
  }
  if (draft.span !== undefined) {
    input.span = draft.span;
  }
  return input;
}

/** Stable text of what would be saved, to tell whether the draft changed since it was loaded. */
export function fingerprintOf(taxonomy: Taxonomy, draft: Draft): string {
  return JSON.stringify(buildAnnotationInput(taxonomy, draft, "labeled"));
}
