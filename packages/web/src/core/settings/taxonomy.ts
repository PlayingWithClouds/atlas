import type { LabelClass, LabelGroup } from '@atlas/contracts';

const DEFAULT_GROUP_ID = 'classes';
const DEFAULT_GROUP_LABEL = 'Classes';

function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') {
    return DEFAULT_GROUP_ID;
  }
  return slug;
}

/** Editable text form: `# Group label` header lines followed by one class name per line. */
export function groupsToText(groups: LabelGroup[]): string {
  const blocks = groups.map((group) => [`# ${group.label}`, ...group.classes.map((labelClass) => labelClass.name)].join('\n'));
  return blocks.join('\n\n');
}

function newGroup(label: string, existingIds: Set<string>): LabelGroup {
  let id = slugify(label);
  while (existingIds.has(id)) {
    id = `${id}-2`;
  }
  existingIds.add(id);
  return { id, label, classes: [] };
}

/**
 * Parses the editable text back into groups. Duplicate class names are dropped, and
 * icon/info/thumbnail of classes that already exist are kept.
 */
export function textToGroups(text: string, previous: LabelGroup[]): LabelGroup[] {
  const known = new Map<string, LabelClass>();
  for (const group of previous) {
    for (const labelClass of group.classes) {
      known.set(labelClass.name, labelClass);
    }
  }
  const groups: LabelGroup[] = [];
  const groupIds = new Set<string>();
  const seenNames = new Set<string>();
  let current: LabelGroup | undefined;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }
    if (line.startsWith('#')) {
      current = newGroup(line.replace(/^#+\s*/, '') || DEFAULT_GROUP_LABEL, groupIds);
      groups.push(current);
      continue;
    }
    if (seenNames.has(line)) {
      continue;
    }
    seenNames.add(line);
    if (!current) {
      current = newGroup(DEFAULT_GROUP_LABEL, groupIds);
      groups.push(current);
    }
    const existing = known.get(line);
    current.classes.push(existing ? existing : { name: line });
  }
  return groups.filter((group) => group.classes.length > 0);
}

export function countClasses(groups: LabelGroup[]): number {
  return groups.reduce((total, group) => total + group.classes.length, 0);
}
