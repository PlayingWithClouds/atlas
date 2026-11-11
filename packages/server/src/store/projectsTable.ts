import type { Database } from "bun:sqlite";
import type { Group, Project, ProjectSummary, Taxonomy } from "@atlas/contracts";

interface ProjectRow {
  id: string;
  name: string;
  taxonomy_groups: string;
  taxonomy_version: number;
  prefill_source: string | null;
  live_suggestions: string | null;
}

interface SummaryRow {
  id: string;
  name: string;
  items: number;
  labeled: number;
  skipped: number;
}

const SUMMARY_QUERY = `
  SELECT
    project.id AS id,
    project.name AS name,
    (SELECT COUNT(*) FROM items WHERE items.project_id = project.id) AS items,
    (SELECT COUNT(*) FROM items JOIN annotations
       ON annotations.project_id = items.project_id AND annotations.item_id = items.id
       WHERE items.project_id = project.id AND annotations.status = 'labeled') AS labeled,
    (SELECT COUNT(*) FROM items JOIN annotations
       ON annotations.project_id = items.project_id AND annotations.item_id = items.id
       WHERE items.project_id = project.id AND annotations.status = 'skipped') AS skipped
  FROM projects AS project
  ORDER BY project.created, project.id
`;

function nullable(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  return value;
}

function projectOf(row: ProjectRow): Project {
  const project: Project = {
    id: row.id,
    name: row.name,
    taxonomy: { version: row.taxonomy_version, groups: JSON.parse(row.taxonomy_groups) },
  };
  if (row.prefill_source !== null) {
    project.prefillSource = row.prefill_source;
  }
  if (row.live_suggestions !== null) {
    project.liveSuggestions = row.live_suggestions;
  }
  return project;
}

export class ProjectsTable {
  constructor(private readonly database: Database) {}

  list(): ProjectSummary[] {
    return this.database.query(SUMMARY_QUERY).all() as SummaryRow[];
  }

  get(projectId: string): Project | undefined {
    const row = this.database.query("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | null;
    if (row === null) {
      return undefined;
    }
    return projectOf(row);
  }

  insert(id: string, name: string, groups: Group[], prefillSource: string | undefined): void {
    this.database
      .query(
        "INSERT INTO projects (id, name, taxonomy_groups, taxonomy_version, prefill_source, created) VALUES (?, ?, ?, 1, ?, ?)",
      )
      .run(id, name, JSON.stringify(groups), nullable(prefillSource), new Date().toISOString());
  }

  rename(projectId: string, name: string): void {
    this.database.query("UPDATE projects SET name = ? WHERE id = ?").run(name, projectId);
  }

  setPrefillSource(projectId: string, prefillSource: string | null): void {
    this.database.query("UPDATE projects SET prefill_source = ? WHERE id = ?").run(prefillSource, projectId);
  }

  setLiveSuggestions(projectId: string, url: string | null): void {
    this.database.query("UPDATE projects SET live_suggestions = ? WHERE id = ?").run(url, projectId);
  }

  replaceTaxonomy(projectId: string, taxonomy: Taxonomy): void {
    this.database
      .query("UPDATE projects SET taxonomy_groups = ?, taxonomy_version = ? WHERE id = ?")
      .run(JSON.stringify(taxonomy.groups), taxonomy.version, projectId);
  }
}
