import type { ItemFilterQuery, ItemStatus, SimilarItem, Taxonomy } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";

/** A label the model gives at least this probability counts as suggested (`label` filter). */
export const LIKELY = 0.5;
/** Probabilities within the margin of 0.5 count as the model being unsure. */
export const DEFAULT_MARGIN = 0.15;
const MINIMUM_MARGIN = 0.05;
const MAXIMUM_MARGIN = 0.45;

export type ItemSort = "order" | "queue" | "match";

const STATUSES: ItemStatus[] = ["pending", "labeled", "skipped"];
const SORTS: ItemSort[] = ["order", "queue", "match"];

export interface LabelReference {
  group: string;
  label?: string;
}

/**
 * A validated filter. `modelSource` is the suggestion source label filters read; `similarItems`
 * is the search's answer for `similar` (a description) or `like` (an item), filled in before
 * the query runs.
 */
export interface ItemFilter {
  status?: ItemStatus;
  search?: string;
  label?: { group: string; label: string };
  unsure?: LabelReference;
  margin: number;
  similar?: string;
  like?: string;
  sort: ItemSort;
  modelSource?: string;
  similarItems?: SimilarItem[];
}

export interface UnsureBand {
  low: number;
  high: number;
}

export function bandOf(margin: number): UnsureBand {
  return { low: 0.5 - margin, high: 0.5 + margin };
}

/** A margin from the URL; absent means the default, anything outside 0.05–0.45 is a 400. */
export function readMargin(margin: string | number | undefined): number {
  if (margin === undefined || margin === "") {
    return DEFAULT_MARGIN;
  }
  const parsed = Number(margin);
  if (!Number.isFinite(parsed) || parsed < MINIMUM_MARGIN || parsed > MAXIMUM_MARGIN) {
    throw new HttpError(400, `margin must be between ${MINIMUM_MARGIN} and ${MAXIMUM_MARGIN}`);
  }
  return parsed;
}

/** q, label, unsure, similar or like is set: the list is narrowed, so counts are worth giving. */
export function isNarrowed(filter: ItemFilter): boolean {
  return filter.search !== undefined || filter.label !== undefined || filter.unsure !== undefined || isSearch(filter);
}

/** The list comes from the project's search (by description or by example). */
export function isSearch(filter: ItemFilter): boolean {
  return filter.similar !== undefined || filter.like !== undefined;
}

export interface SqlPart {
  sql: string;
  params: (string | number)[];
}

export function needsModel(filter: ItemFilter): boolean {
  return filter.label !== undefined || filter.unsure !== undefined;
}

/** Checks a raw query against the taxonomy; unknown groups or labels are a 400. */
export function readFilter(query: ItemFilterQuery, taxonomy: Taxonomy): ItemFilter {
  const filter: ItemFilter = { sort: readSort(query.sort), margin: readMargin(query.margin) };
  const status = readStatus(query.status);
  if (status !== undefined) {
    filter.status = status;
  }
  if (query.q !== undefined && query.q.trim() !== "") {
    filter.search = query.q.trim();
  }
  if (query.label !== undefined && query.label !== "") {
    const reference = readReference(query.label, taxonomy, "label");
    if (reference.label === undefined) {
      throw new HttpError(400, "label must be group.label");
    }
    filter.label = { group: reference.group, label: reference.label };
  }
  if (query.unsure !== undefined && query.unsure !== "") {
    filter.unsure = readReference(query.unsure, taxonomy, "unsure");
  }
  if (query.similar !== undefined && query.similar.trim() !== "") {
    filter.similar = query.similar.trim();
  }
  if (query.like !== undefined && query.like !== "") {
    filter.like = query.like;
  }
  return filter;
}

function readStatus(status: string | undefined): ItemStatus | undefined {
  if (status === undefined || status === "") {
    return undefined;
  }
  const match = STATUSES.find((candidate) => candidate === status);
  if (match === undefined) {
    throw new HttpError(400, "status must be pending, labeled or skipped");
  }
  return match;
}

function readSort(sort: string | undefined): ItemSort {
  if (sort === undefined || sort === "") {
    return "order";
  }
  const match = SORTS.find((candidate) => candidate === sort);
  if (match === undefined) {
    throw new HttpError(400, "sort must be order, queue or match");
  }
  return match;
}

/** `group` or `group.label`, both known to the taxonomy (so they are safe inside a JSON path). */
function readReference(text: string, taxonomy: Taxonomy, name: string): LabelReference {
  const [groupId, labelId, ...rest] = text.split(".");
  const group = taxonomy.groups.find((candidate) => candidate.id === groupId);
  if (group === undefined || rest.length > 0) {
    throw new HttpError(400, `${name}: no group "${groupId}"`);
  }
  if (labelId === undefined) {
    return { group: group.id };
  }
  const label = group.labels.find((candidate) => candidate.id === labelId);
  if (label === undefined) {
    throw new HttpError(400, `${name}: no label "${labelId}" in group "${groupId}"`);
  }
  return { group: group.id, label: label.id };
}

export function valuesPath(group: string, label?: string): string {
  if (label === undefined) {
    return `$.values."${group}"`;
  }
  return `$.values."${group}"."${label}"`;
}

/**
 * LEFT JOIN of the model's suggestion as `model`, and with `similar` or `like` an inner join of
 * the search's answer as `semantic` (items it did not find drop out).
 */
export function modelJoin(filter: ItemFilter): SqlPart {
  const model = {
    sql: `LEFT JOIN suggestions AS model
            ON model.project_id = items.project_id AND model.item_id = items.id AND model.source = ?`,
    params: [modelSourceOf(filter)],
  };
  if (!isSearch(filter)) {
    return model;
  }
  return joinParts([
    model,
    {
      sql: `JOIN (SELECT json_extract(value, '$.itemId') AS item_id, json_extract(value, '$.score') AS score,
                         json_extract(value, '$.at') AS at
                  FROM json_each(?)) AS semantic ON semantic.item_id = items.id`,
      params: [JSON.stringify(similarItemsOf(filter))],
    },
  ]);
}

function similarItemsOf(filter: ItemFilter): SimilarItem[] {
  if (filter.similarItems === undefined) {
    return [];
  }
  return filter.similarItems;
}

function modelSourceOf(filter: ItemFilter): string {
  if (filter.modelSource === undefined) {
    return "";
  }
  return filter.modelSource;
}

/** WHERE conditions (each starting with AND) over `items`, `assets`, `annotations` and `model`. */
export function filterConditions(filter: ItemFilter): SqlPart {
  const parts = [statusCondition(filter.status), searchCondition(filter.search)];
  if (filter.label !== undefined) {
    parts.push(labelCondition(filter.label.group, filter.label.label));
  }
  if (filter.unsure !== undefined) {
    parts.push(unsureCondition(filter.unsure, bandOf(filter.margin)));
  }
  return joinParts(parts);
}

/** Where in the item the search matched best (asset seconds), or NULL. */
export function matchAtExpression(filter: ItemFilter): string {
  if (isSearch(filter)) {
    return "semantic.at";
  }
  return "NULL";
}

/** The search score with `similar` or `like`, else the model's probability for the filtered label, or NULL. */
export function matchExpression(filter: ItemFilter): SqlPart {
  if (isSearch(filter)) {
    return { sql: "semantic.score", params: [] };
  }
  if (filter.label !== undefined) {
    return { sql: "json_extract(model.data, ?)", params: [valuesPath(filter.label.group, filter.label.label)] };
  }
  if (filter.unsure === undefined) {
    return { sql: "NULL", params: [] };
  }
  if (filter.unsure.label !== undefined) {
    return { sql: "json_extract(model.data, ?)", params: [valuesPath(filter.unsure.group, filter.unsure.label)] };
  }
  return {
    sql: `(SELECT entry.value FROM json_each(model.data, ?) AS entry
           WHERE entry.value BETWEEN ? AND ? ORDER BY ABS(entry.value - 0.5) LIMIT 1)`,
    params: [valuesPath(filter.unsure.group), bandOf(filter.margin).low, bandOf(filter.margin).high],
  };
}

/** ORDER BY terms; expects the select to name its columns `match`, `priority` and `sequence`. */
export function orderTerms(filter: ItemFilter): string {
  if (filter.sort === "queue") {
    return "priority IS NULL, priority DESC, sequence";
  }
  if (filter.sort !== "match") {
    return "sequence";
  }
  if (isSearch(filter) || filter.label !== undefined) {
    return "match IS NULL, match DESC, sequence";
  }
  if (filter.unsure !== undefined) {
    return "match IS NULL, ABS(match - 0.5), sequence";
  }
  return "priority IS NULL, priority DESC, sequence";
}

function statusCondition(status: ItemStatus | undefined): SqlPart {
  if (status === undefined) {
    return { sql: "", params: [] };
  }
  if (status === "pending") {
    return { sql: "AND annotations.item_id IS NULL", params: [] };
  }
  return { sql: "AND annotations.status = ?", params: [status] };
}

function searchCondition(search: string | undefined): SqlPart {
  if (search === undefined) {
    return { sql: "", params: [] };
  }
  const pattern = `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  return {
    sql: `AND (json_extract(assets.data, '$.title') LIKE ? ESCAPE '\\' OR items.id LIKE ? ESCAPE '\\')`,
    params: [pattern, pattern],
  };
}

/** Labeled items: the label on the whole item or a range. Others: the model suggests it. */
function labelCondition(group: string, label: string): SqlPart {
  return {
    sql: `AND (
      (annotations.status = 'labeled' AND (
        EXISTS (SELECT 1 FROM json_each(annotations.data, ?) AS entry WHERE entry.value = ?)
        OR ${rangeHas("annotations")}))
      OR (annotations.status IS NOT 'labeled' AND (
        json_extract(model.data, ?) >= ?
        OR ${rangeHas("model")})))`,
    params: [valuesPath(group), label, group, label, valuesPath(group, label), LIKELY, group, label],
  };
}

function rangeHas(table: string): string {
  return `EXISTS (SELECT 1 FROM json_each(${table}.data, '$.ranges') AS range
                  WHERE json_extract(range.value, '$.group') = ? AND json_extract(range.value, '$.label') = ?)`;
}

function unsureCondition(reference: LabelReference, band: UnsureBand): SqlPart {
  if (reference.label !== undefined) {
    return {
      sql: "AND json_extract(model.data, ?) BETWEEN ? AND ?",
      params: [valuesPath(reference.group, reference.label), band.low, band.high],
    };
  }
  return {
    sql: "AND EXISTS (SELECT 1 FROM json_each(model.data, ?) AS entry WHERE entry.value BETWEEN ? AND ?)",
    params: [valuesPath(reference.group), band.low, band.high],
  };
}

function joinParts(parts: SqlPart[]): SqlPart {
  return {
    sql: parts.map((part) => part.sql).join("\n"),
    params: parts.flatMap((part) => part.params),
  };
}
