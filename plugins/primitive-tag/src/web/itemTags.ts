import type { Annotation, Item, LabelGroup } from "@atlas/contracts";

export const TAG_ANNOTATION_TYPE = "tag";

/** Class names across all groups in display order, matching the TagGrid digit numbering. */
export function classNamesOfGroups(groups: LabelGroup[]): string[] {
  return groups.flatMap((group) => group.classes.map((labelClass) => labelClass.name));
}

export function tagsOf(item: Item): string[] {
  const tags: string[] = [];
  for (const annotation of item.annotations) {
    if (annotation.type === TAG_ANNOTATION_TYPE) {
      tags.push(...labelsOf(annotation));
    }
  }
  return tags;
}

function labelsOf(annotation: Annotation): string[] {
  const labels = annotation.value.labels;
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels.filter((label): label is string => typeof label === "string");
}

/** Replaces the item's tag annotation, keeping annotations of other primitives untouched. */
export function annotationsWithTags(item: Item, labels: string[]): Annotation[] {
  const others = item.annotations.filter((annotation) => annotation.type !== TAG_ANNOTATION_TYPE);
  if (labels.length === 0) {
    return others;
  }
  return [...others, { type: TAG_ANNOTATION_TYPE, value: { labels } }];
}

/** Existing labels win; otherwise every suggestion at or above the threshold is preselected. */
export function initialSelection(existing: string[], suggestions: Record<string, number>, threshold: number): Set<string> {
  if (existing.length > 0) {
    return new Set(existing);
  }
  const picks = new Set<string>();
  for (const [name, probability] of Object.entries(suggestions)) {
    if (probability >= threshold) {
      picks.add(name);
    }
  }
  return picks;
}

export function tagsOnEvery(items: Item[]): Set<string> {
  if (items.length === 0) {
    return new Set();
  }
  const common = new Set(tagsOf(items[0]));
  for (const item of items.slice(1)) {
    const present = new Set(tagsOf(item));
    for (const tag of [...common]) {
      if (!present.has(tag)) {
        common.delete(tag);
      }
    }
  }
  return common;
}

export function tagsOnSome(items: Item[], common: Set<string>): Set<string> {
  const partial = new Set<string>();
  for (const item of items) {
    for (const tag of tagsOf(item)) {
      if (!common.has(tag)) {
        partial.add(tag);
      }
    }
  }
  return partial;
}

export interface BatchEdit {
  chosen: Set<string>;
  /** Tags the dialog opened with; unchecking one of them is an explicit removal. */
  seeded: Set<string>;
  replace: boolean;
}

/** Merge keeps what an item had, minus tags the user unchecked after they were pre-filled. */
export function labelsAfterBatch(existing: string[], edit: BatchEdit): string[] {
  const chosen = [...edit.chosen];
  if (edit.replace) {
    return chosen;
  }
  const merged = new Set([...existing, ...chosen]);
  for (const tag of edit.seeded) {
    if (!edit.chosen.has(tag)) {
      merged.delete(tag);
    }
  }
  return [...merged];
}

/** Case-insensitive class search, at most nine hits so digits 1-9 can pick them. */
export function searchClasses(classNames: string[], query: string, rankBy: Record<string, number> = {}): string[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return [];
  }
  return classNames
    .filter((name) => name.toLowerCase().includes(needle))
    .sort((left, right) => (rankBy[right] || 0) - (rankBy[left] || 0))
    .slice(0, 9);
}

let lastAppliedTags: string[] = [];

/** Remembered across item navigations so a streaky set can reapply the previous tags. */
export function rememberTags(tags: string[]): void {
  lastAppliedTags = [...tags];
}

export function recallTags(): string[] {
  return [...lastAppliedTags];
}
