import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import type { Project, ProjectConfig } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import type { ProjectsService } from "@atlas/contracts/server";
import { slugify } from "./slug";

interface ProjectRow {
  id: string;
  name: string;
  config: string;
  created: string;
  updated: string;
}

const PROJECTS_MIGRATION = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
  );
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    config: JSON.parse(row.config) as ProjectConfig,
    created: row.created,
    updated: row.updated,
  };
}

function requireText(value: unknown, field: string): void {
  if (typeof value !== "string" || value === "") {
    throw new HttpError(400, `config.${field} must be a non-empty string`);
  }
}

export function validateProjectConfig(config: unknown): asserts config is ProjectConfig {
  if (!isRecord(config)) {
    throw new HttpError(400, "config must be an object");
  }
  requireText(config.mediaKind, "mediaKind");
  requireText(config.model, "model");
  if (!Array.isArray(config.primitives)) {
    throw new HttpError(400, "config.primitives must be an array");
  }
  const labels = config.labels;
  if (!isRecord(labels) || !Array.isArray(labels.groups)) {
    throw new HttpError(400, "config.labels.groups must be an array");
  }
}

function requireName(name: unknown): string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new HttpError(400, "name is required");
  }
  return name.trim();
}

export class ProjectsCore extends Service implements ProjectsService {
  static inject = ["db", "live"];

  constructor(ctx: Context) {
    super(ctx, "projects");
    ctx.db.migrate("projects", [{ version: 1, sql: PROJECTS_MIGRATION }]);
    this.ctx.effect(() => this.ctx.live.provideState("projects", () => this.list()), "projects:state");
  }

  list(): Project[] {
    const rows = this.ctx.db.database
      .query("SELECT * FROM projects ORDER BY created, rowid")
      .all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  get(projectId: string): Project | undefined {
    const row = this.ctx.db.database
      .query("SELECT * FROM projects WHERE id = ?")
      .get(projectId) as ProjectRow | null;
    if (row === null) {
      return undefined;
    }
    return rowToProject(row);
  }

  create(name: string, config: ProjectConfig): Project {
    const cleanName = requireName(name);
    validateProjectConfig(config);
    const now = new Date().toISOString();
    const projectId = this.uniqueSlug(cleanName);
    this.ctx.db.database
      .query("INSERT INTO projects (id, name, config, created, updated) VALUES (?, ?, ?, ?, ?)")
      .run(projectId, cleanName, JSON.stringify(config), now, now);
    return this.announce(projectId);
  }

  update(projectId: string, patch: { name?: string; config?: Partial<ProjectConfig> }): Project {
    const existing = this.get(projectId);
    if (!existing) {
      throw new HttpError(404, "project not found");
    }
    const name = this.patchedName(existing, patch.name);
    const config = { ...existing.config, ...patch.config };
    validateProjectConfig(config);
    this.ctx.db.database
      .query("UPDATE projects SET name = ?, config = ?, updated = ? WHERE id = ?")
      .run(name, JSON.stringify(config), new Date().toISOString(), projectId);
    return this.announce(projectId);
  }

  /** Sessions and items go with the project through foreign-key cascades. */
  remove(projectId: string): void {
    const result = this.ctx.db.database.query("DELETE FROM projects WHERE id = ?").run(projectId);
    if (result.changes === 0) {
      throw new HttpError(404, "project not found");
    }
    this.ctx.live.notify();
  }

  private patchedName(existing: Project, name: string | undefined): string {
    if (name === undefined) {
      return existing.name;
    }
    return requireName(name);
  }

  private announce(projectId: string): Project {
    const project = this.get(projectId) as Project;
    this.ctx.emit("project/changed", project);
    this.ctx.live.notify();
    return project;
  }

  private uniqueSlug(name: string): string {
    const base = slugify(name);
    let candidate = base;
    let suffix = 2;
    while (this.get(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }
}

export default ProjectsCore;
