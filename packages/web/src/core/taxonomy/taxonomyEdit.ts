import { removedIds, validateTaxonomy } from '@atlas/contracts';
import type { Group, Label, Taxonomy } from '@atlas/contracts';
import { isReservedHotkey } from '../labeling/keyboardMap';

export type EditableGroups = Group[];

/** `Arms up!` becomes `arms-up`, the shape ids must have. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug;
}

/** `base`, or `base-2`, `base-3` ... the first one not in `taken`. */
export function uniqueId(base: string, taken: string[]): string {
  const stem = slugify(base);
  if (stem !== '' && !taken.includes(stem)) {
    return stem;
  }
  const fallback = stem === '' ? 'item' : stem;
  let counter = 2;
  while (taken.includes(`${fallback}-${counter}`)) {
    counter += 1;
  }
  return `${fallback}-${counter}`;
}

export function newGroup(groups: Group[]): Group {
  const id = uniqueId('group', groups.map((group) => group.id));
  return { id, label: 'New group', kind: 'single', labels: [] };
}

export function newLabel(group: Group): Label {
  const id = uniqueId('label', group.labels.map((label) => label.id));
  return { id, name: 'New label' };
}

/** Copies of the groups safe to edit in place. */
export function cloneGroups(groups: Group[]): Group[] {
  return structuredClone(groups);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shapeProblemsOfLabel(label: unknown, where: string): string[] {
  if (!isRecord(label)) {
    return [`${where} is not an object`];
  }
  const problems: string[] = [];
  if (typeof label.id !== 'string') {
    problems.push(`${where} needs a text "id"`);
  }
  if (typeof label.name !== 'string') {
    problems.push(`${where} needs a text "name"`);
  }
  return problems;
}

function shapeProblemsOfGroup(group: unknown, index: number): string[] {
  const where = `group #${index + 1}`;
  if (!isRecord(group)) {
    return [`${where} is not an object`];
  }
  const problems: string[] = [];
  if (typeof group.id !== 'string') {
    problems.push(`${where} needs a text "id"`);
  }
  if (typeof group.label !== 'string') {
    problems.push(`${where} needs a text "label"`);
  }
  if (!Array.isArray(group.labels)) {
    problems.push(`${where} needs a "labels" list`);
    return problems;
  }
  group.labels.forEach((label, labelIndex) => {
    problems.push(...shapeProblemsOfLabel(label, `${where}, label #${labelIndex + 1}`));
  });
  return problems;
}

export interface ParsedTaxonomy {
  groups?: Group[];
  problems: string[];
}

/** Reads pasted or uploaded JSON: a taxonomy object, or just its list of groups. */
export function parseTaxonomyJson(text: string): ParsedTaxonomy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { problems: [`not valid JSON: ${(error as Error).message}`] };
  }
  const candidate = isRecord(parsed) ? parsed.groups : parsed;
  if (!Array.isArray(candidate)) {
    return { problems: ['expected {"groups": [...]} or a list of groups'] };
  }
  const problems = candidate.flatMap((group, index) => shapeProblemsOfGroup(group, index));
  if (problems.length > 0) {
    return { problems };
  }
  return { groups: candidate as Group[], problems: [] };
}

/** What the file contains when exporting: the groups, without the server's version counter. */
export function taxonomyToJson(groups: Group[]): string {
  return JSON.stringify({ groups }, null, 2);
}

function warningsOfHotkeys(group: Group): string[] {
  return group.labels
    .filter((label) => label.hotkey !== undefined && isReservedHotkey(label.hotkey))
    .map((label) => `hotkey "${label.hotkey}" of "${group.id}.${label.id}" is used by the labeling screen, so only its digit works`);
}

/** Things worth knowing that do not stop a save. */
export function taxonomyWarnings(groups: Group[]): string[] {
  return groups.flatMap((group) => warningsOfHotkeys(group));
}

/** Everything wrong with the edited groups: the shared rules plus ids that vanished since `previous`. */
export function taxonomyProblems(previous: Taxonomy, groups: Group[]): string[] {
  const problems = validateTaxonomy({ groups });
  const removed = removedIds(previous, { groups });
  for (const id of removed) {
    problems.push(`"${id}" was removed; saved ids stay, deprecate labels instead`);
  }
  return problems;
}
