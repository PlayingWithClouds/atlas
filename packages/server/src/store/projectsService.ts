import type { Project, ProjectSummary, Taxonomy } from "@atlas/contracts";
import { removedIds, validateTaxonomy } from "@atlas/contracts";
import { HttpError, ValidationFailure } from "@atlas/contracts/server";
import type { StoreEvents } from "./events";
import { isRecord, parseGroups } from "./parsing";
import type { ProjectsTable } from "./projectsTable";

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function requireRecord(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new ValidationFailure(["the body must be a JSON object"]);
  }
  return raw;
}

function requireName(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ValidationFailure(["name must be a non-empty string"]);
  }
  return raw;
}

function readPrefillSource(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || typeof raw === "string") {
    return raw;
  }
  throw new ValidationFailure(["prefillSource must be a string or null"]);
}

/** An adapter URL field of a project: http(s), null to clear, absent to keep. */
function readAdapterUrl(raw: unknown, name: string): string | null | undefined {
  if (raw === undefined || raw === null) {
    return raw;
  }
  if (typeof raw === "string" && /^https?:\/\//.test(raw)) {
    return raw;
  }
  throw new ValidationFailure([`${name} must be an http(s) URL or null`]);
}

function undefinedIfNull(value: string | null | undefined): string | undefined {
  if (value === null) {
    return undefined;
  }
  return value;
}

function readGroups(raw: unknown) {
  const parsed = parseGroups(raw);
  if ("problems" in parsed) {
    throw new ValidationFailure(parsed.problems);
  }
  const problems = validateTaxonomy({ groups: parsed.value });
  if (problems.length > 0) {
    throw new ValidationFailure(problems);
  }
  return parsed.value;
}

function removalProblems(previous: Taxonomy, groups: Taxonomy["groups"]): string[] {
  return removedIds(previous, { groups }).map((id) => `"${id}" may not be removed: mark it deprecated instead`);
}

export class ProjectsService {
  constructor(
    private readonly table: ProjectsTable,
    private readonly events: StoreEvents,
  ) {}

  list(): ProjectSummary[] {
    return this.table.list();
  }

  require(projectId: string): Project {
    const project = this.table.get(projectId);
    if (project === undefined) {
      throw new HttpError(404, `project "${projectId}" not found`);
    }
    return project;
  }

  create(raw: unknown): Project {
    const body = requireRecord(raw);
    if (typeof body.id !== "string" || !PROJECT_ID_PATTERN.test(body.id)) {
      throw new ValidationFailure(['id must be lowercase letters, digits, "_" or "-"']);
    }
    const name = requireName(body.name);
    const prefillSource = readPrefillSource(body.prefillSource);
    const groups = this.readInitialGroups(body.taxonomy);
    if (this.table.get(body.id) !== undefined) {
      throw new HttpError(409, `project "${body.id}" already exists`);
    }
    this.table.insert(body.id, name, groups, undefinedIfNull(prefillSource));
    this.events.emit({ type: "projects" });
    return this.require(body.id);
  }

  patch(projectId: string, raw: unknown): Project {
    const body = requireRecord(raw);
    this.require(projectId);
    if (body.name !== undefined) {
      this.table.rename(projectId, requireName(body.name));
    }
    const prefillSource = readPrefillSource(body.prefillSource);
    if (prefillSource !== undefined) {
      this.table.setPrefillSource(projectId, prefillSource);
    }
    const liveSuggestions = readAdapterUrl(body.liveSuggestions, "liveSuggestions");
    if (liveSuggestions !== undefined) {
      this.table.setLiveSuggestions(projectId, liveSuggestions);
    }
    const semanticSearch = readAdapterUrl(body.semanticSearch, "semanticSearch");
    if (semanticSearch !== undefined) {
      this.table.setSemanticSearch(projectId, semanticSearch);
    }
    this.events.emit({ type: "projects" });
    return this.require(projectId);
  }

  replaceTaxonomy(projectId: string, raw: unknown): Taxonomy {
    const body = requireRecord(raw);
    const previous = this.require(projectId).taxonomy;
    const groups = readGroups(body.groups);
    const problems = removalProblems(previous, groups);
    if (problems.length > 0) {
      throw new ValidationFailure(problems);
    }
    const taxonomy: Taxonomy = { version: previous.version + 1, groups };
    this.table.replaceTaxonomy(projectId, taxonomy);
    this.events.emit({ type: "taxonomy", projectId, taxonomy });
    return taxonomy;
  }

  private readInitialGroups(rawTaxonomy: unknown) {
    if (rawTaxonomy === undefined) {
      return [];
    }
    return readGroups(requireRecord(rawTaxonomy).groups);
  }
}
