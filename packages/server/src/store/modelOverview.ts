import type { Database } from "bun:sqlite";
import type { ModelGroupOverview, ModelOverview, Taxonomy } from "@atlas/contracts";
import { LIKELY, UNSURE_HIGH, UNSURE_LOW } from "./itemFilter";

interface LabelCountRow {
  group_id: string;
  label_id: string;
  likely: number;
  unsure: number;
}

interface LabeledRow {
  group_id: string;
  label_id: string;
  labeled: number;
}

interface GroupCountRow {
  group_id: string;
  unsure: number;
}

/** Joins every pending item to the model's suggestion for it as `model`. */
const PENDING_WITH_MODEL = `
  FROM items
  JOIN suggestions AS model
    ON model.project_id = items.project_id AND model.item_id = items.id AND model.source = ?
  LEFT JOIN annotations ON annotations.project_id = items.project_id AND annotations.item_id = items.id
`;

type CountKey = `${string}\u0000${string}`;

function keyOf(group: string, label: string): CountKey {
  return `${group}\u0000${label}`;
}

function countOf<Key>(counts: Map<Key, number>, key: Key): number {
  const count = counts.get(key);
  if (count === undefined) {
    return 0;
  }
  return count;
}

/** Per label, how many pending items the model suggests it for or is unsure about. */
export class ModelOverviewQuery {
  constructor(private readonly database: Database) {}

  overview(projectId: string, source: string | undefined, taxonomy: Taxonomy): ModelOverview {
    const pending = this.countPending(projectId);
    if (source === undefined) {
      return { pending, suggested: 0, groups: this.assemble(taxonomy, new Map(), new Map(), new Map()) };
    }
    return {
      source,
      pending,
      suggested: this.countSuggested(projectId, source),
      groups: this.assemble(
        taxonomy,
        this.labelCounts(projectId, source),
        this.labeledCounts(projectId),
        this.groupUnsure(projectId, source),
      ),
    };
  }

  private assemble(
    taxonomy: Taxonomy,
    counts: Map<CountKey, LabelCountRow>,
    labeled: Map<CountKey, number>,
    groupUnsure: Map<string, number>,
  ): ModelGroupOverview[] {
    return taxonomy.groups.map((group) => ({
      group: group.id,
      unsure: countOf(groupUnsure, group.id),
      labels: group.labels
        .filter((label) => label.deprecated !== true)
        .map((label) => {
          const key = keyOf(group.id, label.id);
          const count = counts.get(key);
          if (count === undefined) {
            return { label: label.id, labeled: countOf(labeled, key), likely: 0, unsure: 0 };
          }
          return { label: label.id, labeled: countOf(labeled, key), likely: count.likely, unsure: count.unsure };
        }),
    }));
  }

  private labelCounts(projectId: string, source: string): Map<CountKey, LabelCountRow> {
    const rows = this.database
      .query(
        `SELECT group_entry.key AS group_id, label_entry.key AS label_id,
                SUM(label_entry.value >= ?) AS likely,
                SUM(label_entry.value BETWEEN ? AND ?) AS unsure
         ${PENDING_WITH_MODEL},
         json_each(model.data, '$.values') AS group_entry,
         json_each(group_entry.value) AS label_entry
         WHERE items.project_id = ? AND annotations.item_id IS NULL
         GROUP BY group_entry.key, label_entry.key`,
      )
      .all(LIKELY, UNSURE_LOW, UNSURE_HIGH, source, projectId) as LabelCountRow[];
    return new Map(rows.map((row) => [keyOf(row.group_id, row.label_id), row]));
  }

  private groupUnsure(projectId: string, source: string): Map<string, number> {
    const rows = this.database
      .query(
        `SELECT group_entry.key AS group_id, COUNT(DISTINCT items.id) AS unsure
         ${PENDING_WITH_MODEL},
         json_each(model.data, '$.values') AS group_entry,
         json_each(group_entry.value) AS label_entry
         WHERE items.project_id = ? AND annotations.item_id IS NULL AND label_entry.value BETWEEN ? AND ?
         GROUP BY group_entry.key`,
      )
      .all(source, projectId, UNSURE_LOW, UNSURE_HIGH) as GroupCountRow[];
    return new Map(rows.map((row) => [row.group_id, row.unsure]));
  }

  /** Labeled items per label, whether it holds for the whole item or a range. */
  private labeledCounts(projectId: string): Map<CountKey, number> {
    const rows = this.database
      .query(
        `SELECT group_id, label_id, COUNT(DISTINCT item_id) AS labeled FROM (
           SELECT annotations.item_id AS item_id, group_entry.key AS group_id, label_entry.value AS label_id
           FROM annotations, json_each(annotations.data, '$.values') AS group_entry, json_each(group_entry.value) AS label_entry
           WHERE annotations.project_id = ? AND annotations.status = 'labeled'
           UNION ALL
           SELECT annotations.item_id, json_extract(range.value, '$.group'), json_extract(range.value, '$.label')
           FROM annotations, json_each(annotations.data, '$.ranges') AS range
           WHERE annotations.project_id = ? AND annotations.status = 'labeled'
         ) GROUP BY group_id, label_id`,
      )
      .all(projectId, projectId) as LabeledRow[];
    return new Map(rows.map((row) => [keyOf(row.group_id, row.label_id), row.labeled]));
  }

  private countPending(projectId: string): number {
    const row = this.database
      .query(
        `SELECT COUNT(*) AS count FROM items
         LEFT JOIN annotations ON annotations.project_id = items.project_id AND annotations.item_id = items.id
         WHERE items.project_id = ? AND annotations.item_id IS NULL`,
      )
      .get(projectId) as { count: number };
    return row.count;
  }

  private countSuggested(projectId: string, source: string): number {
    const row = this.database
      .query(
        `SELECT COUNT(*) AS count ${PENDING_WITH_MODEL}
         WHERE items.project_id = ? AND annotations.item_id IS NULL AND json_type(model.data, '$.values') IS NOT NULL`,
      )
      .get(source, projectId) as { count: number };
    return row.count;
  }
}
