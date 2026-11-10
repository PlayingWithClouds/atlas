import type { Asset, AnnotationInput, Group, Item, Label, Range, Span, Suggestion } from "@atlas/contracts";

/** The outcome of reading an untrusted record: the clean value, or what is wrong with it. */
export type Parsed<Value> = { value: Value } | { problems: string[] };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  if (isNumber(value)) {
    return value;
  }
  return undefined;
}

function trueOrUndefined(value: unknown): true | undefined {
  if (value === true) {
    return true;
  }
  return undefined;
}

function failure(problem: string): { problems: string[] } {
  return { problems: [problem] };
}

function optionalText(record: Record<string, unknown>, field: string, problems: string[]): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    problems.push(`${field} must be a string`);
    return undefined;
  }
  return value;
}

function optionalNumber(record: Record<string, unknown>, field: string, problems: string[]): number | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isNumber(value) || value < 0) {
    problems.push(`${field} must be a number of at least 0`);
    return undefined;
  }
  return value;
}

function optionalObject(record: Record<string, unknown>, field: string, problems: string[]): Record<string, unknown> | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    problems.push(`${field} must be an object`);
    return undefined;
  }
  return value;
}

function withoutUndefined<Value extends object>(value: Value): Value {
  const entries = Object.entries(value).filter(([, field]) => field !== undefined);
  return Object.fromEntries(entries) as Value;
}

// --- assets and items --------------------------------------------------------------------

export function parseAsset(raw: unknown): Parsed<Asset> {
  if (!isRecord(raw)) {
    return failure("an asset must be an object");
  }
  const problems: string[] = [];
  if (!isText(raw.id)) {
    problems.push("id must be a non-empty string");
  }
  if (raw.kind !== "video" && raw.kind !== "image") {
    problems.push('kind must be "video" or "image"');
  }
  if (!isText(raw.url)) {
    problems.push("url must be a non-empty string");
  }
  const asset = {
    id: raw.id as string,
    kind: raw.kind as Asset["kind"],
    url: raw.url as string,
    poster: optionalText(raw, "poster", problems),
    duration: optionalNumber(raw, "duration", problems),
    width: optionalNumber(raw, "width", problems),
    height: optionalNumber(raw, "height", problems),
    title: optionalText(raw, "title", problems),
    meta: optionalObject(raw, "meta", problems),
  };
  if (problems.length > 0) {
    return { problems };
  }
  return { value: withoutUndefined(asset) };
}

function readSpan(raw: unknown, problems: string[]): Span | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isRecord(raw) || !isNumber(raw.start) || !isNumber(raw.end)) {
    problems.push("span needs numeric start and end");
    return undefined;
  }
  if (!(raw.start >= 0 && raw.start < raw.end)) {
    problems.push("span needs 0 ≤ start < end");
    return undefined;
  }
  return { start: raw.start, end: raw.end };
}

export function parseItem(raw: unknown): Parsed<Item> {
  if (!isRecord(raw)) {
    return failure("an item must be an object");
  }
  const problems: string[] = [];
  if (!isText(raw.id)) {
    problems.push("id must be a non-empty string");
  }
  if (!isText(raw.assetId)) {
    problems.push("assetId must be a non-empty string");
  }
  const item = {
    id: raw.id as string,
    assetId: raw.assetId as string,
    span: readSpan(raw.span, problems),
    poster: optionalText(raw, "poster", problems),
    meta: optionalObject(raw, "meta", problems),
  };
  if (problems.length > 0) {
    return { problems };
  }
  return { value: withoutUndefined(item) };
}

/** Whether an item's span lies inside its asset; unknown durations accept any span. */
export function spanProblems(item: Item, asset: Asset): string[] {
  if (item.span === undefined || asset.duration === undefined) {
    return [];
  }
  if (item.span.end > asset.duration + 1e-3) {
    return [`span ends after the asset (${asset.duration} s)`];
  }
  return [];
}

// --- annotations -------------------------------------------------------------------------

function parseValues(raw: unknown, problems: string[]): Record<string, string[]> {
  if (!isRecord(raw)) {
    problems.push("values must be an object of group id to label ids");
    return {};
  }
  const values: Record<string, string[]> = {};
  for (const [groupId, labelIds] of Object.entries(raw)) {
    if (!Array.isArray(labelIds) || !labelIds.every((labelId) => typeof labelId === "string")) {
      problems.push(`values.${groupId} must be an array of label ids`);
      continue;
    }
    values[groupId] = labelIds;
  }
  return values;
}

function parseRange(raw: unknown, problems: string[]): Range | undefined {
  const isShapeValid =
    isRecord(raw) && typeof raw.group === "string" && typeof raw.label === "string" && isNumber(raw.start) && isNumber(raw.end);
  if (!isShapeValid) {
    problems.push("a range needs group, label, start and end");
    return undefined;
  }
  return { group: raw.group as string, label: raw.label as string, start: raw.start as number, end: raw.end as number };
}

function parseRanges(raw: unknown, problems: string[]): Range[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    problems.push("ranges must be an array");
    return undefined;
  }
  const ranges: Range[] = [];
  for (const entry of raw) {
    const range = parseRange(entry, problems);
    if (range !== undefined) {
      ranges.push(range);
    }
  }
  return ranges;
}

function parseReviewed(raw: unknown, problems: string[]): string[] {
  if (!Array.isArray(raw) || !raw.every((groupId) => typeof groupId === "string")) {
    problems.push("reviewed must be an array of group ids");
    return [];
  }
  return raw;
}

export function parseAnnotationInput(raw: unknown): Parsed<AnnotationInput> {
  if (!isRecord(raw)) {
    return failure("the annotation must be an object");
  }
  const problems: string[] = [];
  if (raw.status !== "labeled" && raw.status !== "skipped") {
    problems.push('status must be "labeled" or "skipped"');
  }
  const input = {
    status: raw.status as AnnotationInput["status"],
    values: parseValues(raw.values, problems),
    ranges: parseRanges(raw.ranges, problems),
    reviewed: parseReviewed(raw.reviewed, problems),
    span: readSpan(raw.span, problems),
  };
  if (problems.length > 0) {
    return { problems };
  }
  return { value: withoutUndefined(input) };
}

// --- suggestions -------------------------------------------------------------------------

function isProbability(value: unknown): boolean {
  return isNumber(value) && value >= 0 && value <= 1;
}

function suggestionValueProblems(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!isRecord(raw)) {
    return ["values must be an object of group id to label probabilities"];
  }
  const isValid = Object.values(raw).every(
    (labels) => isRecord(labels) && Object.values(labels).every(isProbability),
  );
  if (!isValid) {
    return ["values must map group → label → probability between 0 and 1"];
  }
  return [];
}

function suggestionRangeProblems(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  const problems: string[] = [];
  if (!Array.isArray(raw)) {
    return ["ranges must be an array"];
  }
  for (const entry of raw) {
    parseRange(entry, problems);
    if (isRecord(entry) && !isProbability(entry.score)) {
      problems.push("a range needs a score between 0 and 1");
    }
  }
  return problems;
}

export function parseSuggestion(raw: unknown): Parsed<Suggestion> {
  if (!isRecord(raw)) {
    return failure("a suggestion must be an object");
  }
  const problems: string[] = [];
  if (!isText(raw.itemId)) {
    problems.push("itemId must be a non-empty string");
  }
  if (!isText(raw.source)) {
    problems.push("source must be a non-empty string");
  }
  problems.push(...suggestionValueProblems(raw.values));
  problems.push(...suggestionRangeProblems(raw.ranges));
  if (raw.priority !== undefined && raw.priority !== null && !isNumber(raw.priority)) {
    problems.push("priority must be a number");
  }
  if (problems.length > 0) {
    return { problems };
  }
  const suggestion = {
    itemId: raw.itemId as string,
    source: raw.source as string,
    values: raw.values as Suggestion["values"],
    ranges: raw.ranges as Suggestion["ranges"],
    priority: numberOrUndefined(raw.priority),
  };
  return { value: withoutUndefined(suggestion) };
}

// --- taxonomy ----------------------------------------------------------------------------

function parseLabel(raw: unknown, groupId: string, problems: string[]): Label | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.name !== "string") {
    problems.push(`group "${groupId}" has a label without string id and name`);
    return undefined;
  }
  const label = {
    id: raw.id,
    name: raw.name,
    description: optionalText(raw, "description", problems),
    image: optionalText(raw, "image", problems),
    hotkey: optionalText(raw, "hotkey", problems),
    deprecated: trueOrUndefined(raw.deprecated),
  };
  return withoutUndefined(label);
}

function parseLabels(raw: unknown, groupId: string, problems: string[]): Label[] {
  if (!Array.isArray(raw)) {
    problems.push(`group "${groupId}" needs a labels array`);
    return [];
  }
  const labels: Label[] = [];
  for (const entry of raw) {
    const label = parseLabel(entry, groupId, problems);
    if (label !== undefined) {
      labels.push(label);
    }
  }
  return labels;
}

function parseCondition(raw: unknown, groupId: string, problems: string[]): Group["when"] {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isRecord(raw) || typeof raw.group !== "string" || typeof raw.label !== "string") {
    problems.push(`group "${groupId}" has a malformed "when"`);
    return undefined;
  }
  return { group: raw.group, label: raw.label };
}

function parseGroup(raw: unknown, problems: string[]): Group | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.label !== "string") {
    problems.push("every group needs a string id and label");
    return undefined;
  }
  const group = {
    id: raw.id,
    label: raw.label,
    kind: raw.kind as Group["kind"],
    primary: trueOrUndefined(raw.primary),
    when: parseCondition(raw.when, raw.id, problems),
    labels: parseLabels(raw.labels, raw.id, problems),
  };
  return withoutUndefined(group);
}

/** Reads the shape of a taxonomy's groups; the rules about ids and conditions are `validateTaxonomy`'s. */
export function parseGroups(raw: unknown): Parsed<Group[]> {
  if (!Array.isArray(raw)) {
    return failure("groups must be an array");
  }
  const problems: string[] = [];
  const groups: Group[] = [];
  for (const entry of raw) {
    const group = parseGroup(entry, problems);
    if (group !== undefined) {
      groups.push(group);
    }
  }
  if (problems.length > 0) {
    return { problems };
  }
  return { value: groups };
}
