import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { Span, Workflow } from "@atlas/contracts";
import { createHost } from "../host";
import { ensureWorkspace } from "../services/workspace";
import { validateProjectConfig } from "../services/projects";
import {
  DEFAULT_PROJECT_ID,
  itemMeta,
  mapDefaultProject,
  mapItemRef,
  mapItemStatus,
  mapSessionMeta,
  mapSessionSource,
  mapStoredProject,
  mapWorkflow,
  oldModelOf,
  sessionProjectId,
  storedItemRef,
  usesJoytagNode,
  unixSecondsToIso,
} from "./mapping";
import type { NewProjectRow, OldImage, OldSession, OldWorkflow } from "./mapping";
import { loadImageCounts, loadImages, loadOldProjects, loadOldSessions, readOldConfig } from "./oldData";
import { copyPool, planPool, resolvePython } from "./pools";
import type { PoolPlan } from "./pools";
import type { SurrealReader } from "./surrealClient";
import {
  assertTargetIsSeparate,
  buildPluginEntries,
  defaultVeilPluginDirectory,
  removeTargetPool,
  resetTargetDatabase,
  targetHasData,
  writeWorkspaceConfig,
} from "./target";

export interface MigrateOptions {
  targetDirectory: string;
  oldConfigPath: string;
  oldCacheDirectory: string;
  modelMap: Record<string, string>;
  dryRun: boolean;
  force: boolean;
  skipPools: boolean;
  pythonPath?: string;
  veilPluginDirectory?: string;
  log: (line: string) => void;
}

export interface ProjectSummary {
  projectId: string;
  sessions: number;
  items: number;
}

export interface MigrationSummary {
  dryRun: boolean;
  projects: ProjectSummary[];
  skippedSessions: string[];
  duplicateItems: number;
  pools: { projectId: string; destinationDirectory: string; rows: number; rewrittenRefs: number }[];
  workflows: number;
  warnings: string[];
}

interface PlannedProject {
  row: NewProjectRow;
  oldModel: string;
}

interface SourceData {
  title: string;
  projects: PlannedProject[];
  sessions: OldSession[];
  imageCounts: Map<string, number>;
  workflows: Workflow[];
  warnings: string[];
}

function plannedStoredProjects(projects: Awaited<ReturnType<typeof loadOldProjects>>, options: MigrateOptions): PlannedProject[] {
  return projects.map((project) => ({
    row: mapStoredProject(project, options.modelMap),
    oldModel: oldModelOf(project.config),
  }));
}

function addDefaultProject(planned: PlannedProject[], oldConfig: Record<string, unknown>, options: MigrateOptions): void {
  if (planned.some((project) => project.row.id === DEFAULT_PROJECT_ID)) {
    return;
  }
  const row = mapDefaultProject(oldConfig, options.modelMap, new Date().toISOString());
  planned.push({ row, oldModel: "model" });
}

function oldWorkflowsOf(oldConfig: Record<string, unknown>): OldWorkflow[] {
  if (!Array.isArray(oldConfig.workflows)) {
    return [];
  }
  return oldConfig.workflows as OldWorkflow[];
}

function titleOf(oldConfig: Record<string, unknown>): string {
  if (typeof oldConfig.title === "string" && oldConfig.title !== "") {
    return oldConfig.title;
  }
  return "atlas";
}

async function loadSourceData(reader: SurrealReader, options: MigrateOptions): Promise<SourceData> {
  const warnings: string[] = [];
  const oldConfig = readOldConfig(options.oldConfigPath);
  if (oldConfig.missing) {
    warnings.push(`old config ${options.oldConfigPath} not found; default project has no labels and no workflows were migrated`);
  }
  const projects = plannedStoredProjects(await loadOldProjects(reader), options);
  addDefaultProject(projects, oldConfig.config, options);
  for (const project of projects) {
    validateProjectConfig(project.row.config);
  }
  return {
    title: titleOf(oldConfig.config),
    projects,
    sessions: await loadOldSessions(reader),
    imageCounts: await loadImageCounts(reader),
    workflows: oldWorkflowsOf(oldConfig.config).map(mapWorkflow),
    warnings,
  };
}

// --- planning ----------------------------------------------------------------------------

function migratableSessions(data: SourceData, skipped: string[]): OldSession[] {
  const projectIds = new Set(data.projects.map((project) => project.row.id));
  return data.sessions.filter((session) => {
    if (projectIds.has(sessionProjectId(session))) {
      return true;
    }
    skipped.push(session.id);
    return false;
  });
}

function summarizeProjects(data: SourceData, sessions: OldSession[]): ProjectSummary[] {
  return data.projects.map((project) => {
    const owned = sessions.filter((session) => sessionProjectId(session) === project.row.id);
    let items = 0;
    for (const session of owned) {
      const count = data.imageCounts.get(session.id);
      items += count === undefined ? 0 : count;
    }
    return { projectId: project.row.id, sessions: owned.length, items };
  });
}

function planPools(data: SourceData, options: MigrateOptions): PoolPlan[] {
  const plans: PoolPlan[] = [];
  for (const project of data.projects) {
    const plan = planPool(
      { projectId: project.row.id, oldModel: project.oldModel, encoderId: project.row.config.model },
      options.oldCacheDirectory,
      options.targetDirectory,
    );
    if (plan !== undefined) {
      plans.push(plan);
    }
  }
  return plans;
}

function unknownNodeTypes(workflows: Workflow[], knownTypes: Set<string>): string[] {
  const unknown = new Set<string>();
  for (const workflow of workflows) {
    for (const node of workflow.graph.nodes) {
      if (!knownTypes.has(node.type)) {
        unknown.add(node.type);
      }
    }
  }
  return [...unknown].sort();
}

/** A node type counts as known when an enabled plugin's source declares `type: "<id>"`. */
function declaredNodeTypes(pluginDirectories: string[]): Set<string> {
  const declared = new Set<string>();
  const pattern = /type:\s*"([^"]+)"/g;
  for (const directory of pluginDirectories) {
    for (const filePath of listSourceFiles(path.join(directory, "src"))) {
      const text = fs.readFileSync(filePath, "utf8");
      for (const match of text.matchAll(pattern)) {
        declared.add(match[1]);
      }
    }
  }
  return declared;
}

function listSourceFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(entryPath));
    } else if (entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

// --- writing -----------------------------------------------------------------------------

function insertProject(database: Database, row: NewProjectRow): void {
  database
    .query("INSERT INTO projects (id, name, config, created, updated) VALUES (?, ?, ?, ?, ?)")
    .run(row.id, row.name, JSON.stringify(row.config), row.created, row.updated);
}

function insertSession(database: Database, session: OldSession): void {
  const mapped = mapSessionSource(session.source, session.ref);
  database
    .query("INSERT INTO sessions (id, project_id, label, source, producing, created, meta) VALUES (?, ?, ?, ?, 0, ?, ?)")
    .run(
      session.id,
      sessionProjectId(session),
      session.label,
      JSON.stringify(mapped.source),
      unixSecondsToIso(session.created),
      JSON.stringify(mapSessionMeta(session)),
    );
}

interface ItemContext {
  session: OldSession;
  mediaKind: string;
  poolRefs: Set<string> | undefined;
}

function isEmbedded(image: OldImage, ref: string, poolRefs: Set<string> | undefined): boolean {
  if (poolRefs === undefined || image.embedded !== true) {
    return false;
  }
  return poolRefs.has(ref);
}

function spanBound(span: Span | undefined, bound: "start" | "end"): number | null {
  if (span === undefined) {
    return null;
  }
  return span[bound];
}

/** Returns false when the (session, ref) pair already exists. */
function insertItem(database: Database, image: OldImage, context: ItemContext): boolean {
  const mapped = mapItemRef(image);
  const ref = storedItemRef(mapped);
  const span = mapped.span;
  const result = database
    .query(
      `INSERT OR IGNORE INTO items (id, session_id, idx, ref, media_kind, status, annotations, embedded, span_start, span_end, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      image.id,
      context.session.id,
      image.idx,
      ref,
      context.mediaKind,
      mapItemStatus(image),
      JSON.stringify(image.annotations),
      isEmbedded(image, ref, context.poolRefs) ? 1 : 0,
      spanBound(span, "start"),
      spanBound(span, "end"),
      JSON.stringify(itemMeta(context.session, mapped)),
    );
  return result.changes > 0;
}

async function insertSessionItems(database: Database, reader: SurrealReader, context: ItemContext): Promise<number> {
  let duplicates = 0;
  for await (const page of loadImages(reader, context.session.id)) {
    database.transaction(() => {
      for (const image of page) {
        if (!insertItem(database, image, context)) {
          duplicates += 1;
        }
      }
    })();
  }
  return duplicates;
}

// --- orchestration -----------------------------------------------------------------------

function describePlan(summary: MigrationSummary, plans: PoolPlan[], log: (line: string) => void): void {
  log("projects:");
  for (const project of summary.projects) {
    log(`  ${project.projectId}: ${project.sessions} sessions, ${project.items} items`);
  }
  const totalItems = summary.projects.reduce((total, project) => total + project.items, 0);
  log(`totals: ${summary.projects.length} projects, ${summary.projects.reduce((total, project) => total + project.sessions, 0)} sessions, ${totalItems} items, ${summary.workflows} workflows`);
  for (const plan of plans) {
    const names = plan.files.map((file) => `${file.name} (${file.bytes} bytes)`).join(", ");
    log(`pool copy ${plan.projectId}: ${plan.sourceDirectory} -> ${plan.destinationDirectory} [${names}]`);
  }
  for (const sessionId of summary.skippedSessions) {
    log(`skipped session ${sessionId}: its project does not exist`);
  }
}

function prepareTarget(options: MigrateOptions, plans: PoolPlan[]): void {
  assertTargetIsSeparate(options.targetDirectory, [options.oldCacheDirectory]);
  if (targetHasData(options.targetDirectory)) {
    if (!options.force) {
      throw new Error(`target ${options.targetDirectory} already contains data; pass --force to recreate its database`);
    }
    resetTargetDatabase(options.targetDirectory);
  }
  ensureWorkspace(options.targetDirectory);
  if (options.force) {
    plans.forEach((plan) => removeTargetPool(plan.destinationDirectory));
  }
}

async function copyPools(plans: PoolPlan[], options: MigrateOptions, summary: MigrationSummary): Promise<Map<string, Set<string>>> {
  const refsByProject = new Map<string, Set<string>>();
  if (options.skipPools || plans.length === 0) {
    return refsByProject;
  }
  const pythonPath = resolvePython(options.pythonPath);
  for (const plan of plans) {
    const result = await copyPool(plan, pythonPath);
    refsByProject.set(plan.projectId, result.refs);
    summary.pools.push({
      projectId: plan.projectId,
      destinationDirectory: plan.destinationDirectory,
      rows: result.trainRows + result.cacheRows,
      rewrittenRefs: result.rewrittenRefs,
    });
    options.log(`copied pool ${plan.projectId}: ${result.trainRows} labeled + ${result.cacheRows} cached vectors, ${result.rewrittenRefs} refs rewritten`);
  }
  return refsByProject;
}

async function writeDatabase(
  data: SourceData,
  sessions: OldSession[],
  reader: SurrealReader,
  poolRefs: Map<string, Set<string>>,
  options: MigrateOptions,
  summary: MigrationSummary,
): Promise<void> {
  const host = await createHost({ workspaceDirectory: options.targetDirectory, port: 0 });
  try {
    const database = host.context.db.database;
    data.projects.forEach((project) => insertProject(database, project.row));
    for (const session of sessions) {
      insertSession(database, session);
      const projectId = sessionProjectId(session);
      const project = data.projects.find((candidate) => candidate.row.id === projectId) as PlannedProject;
      const context = { session, mediaKind: project.row.config.mediaKind, poolRefs: poolRefs.get(projectId) };
      summary.duplicateItems += await insertSessionItems(database, reader, context);
    }
  } finally {
    await host.stop();
  }
}

function veilDirectoryOf(options: MigrateOptions): string {
  if (options.veilPluginDirectory === undefined) {
    return defaultVeilPluginDirectory();
  }
  return options.veilPluginDirectory;
}

function collectWarnings(data: SourceData, sessions: OldSession[], options: MigrateOptions): string[] {
  const warnings = [...data.warnings];
  for (const session of sessions) {
    const mapped = mapSessionSource(session.source, session.ref);
    if (mapped.warning !== undefined) {
      warnings.push(`session ${session.id}: ${mapped.warning}`);
    }
  }
  const pluginEntries = buildPluginEntries(veilDirectoryOf(options), warnings, usesJoytagNode(data.workflows));
  const known = declaredNodeTypes(pluginEntries.map((entry) => entry.path as string));
  const unknownTypes = unknownNodeTypes(data.workflows, known);
  if (unknownTypes.length > 0) {
    warnings.push(`workflows use node types no enabled plugin declares (the validator will flag them in the UI): ${unknownTypes.join(", ")}`);
  }
  return warnings;
}

export async function runMigration(reader: SurrealReader, options: MigrateOptions): Promise<MigrationSummary> {
  const data = await loadSourceData(reader, options);
  const skippedSessions: string[] = [];
  const sessions = migratableSessions(data, skippedSessions);
  const plans = planPools(data, options);
  const summary: MigrationSummary = {
    dryRun: options.dryRun,
    projects: summarizeProjects(data, sessions),
    skippedSessions,
    duplicateItems: 0,
    pools: [],
    workflows: data.workflows.length,
    warnings: collectWarnings(data, sessions, options),
  };
  describePlan(summary, plans, options.log);
  if (!options.dryRun) {
    await execute(data, sessions, plans, reader, options, summary);
  }
  summary.warnings.forEach((warning) => options.log(`warning: ${warning}`));
  return summary;
}

async function execute(
  data: SourceData,
  sessions: OldSession[],
  plans: PoolPlan[],
  reader: SurrealReader,
  options: MigrateOptions,
  summary: MigrationSummary,
): Promise<void> {
  prepareTarget(options, plans);
  const poolRefs = await copyPools(plans, options, summary);
  await writeDatabase(data, sessions, reader, poolRefs, options, summary);
  writeWorkspaceConfig(options.targetDirectory, data.title, buildPluginEntries(veilDirectoryOf(options), [], usesJoytagNode(data.workflows)), data.workflows);
  options.log(`migrated into ${options.targetDirectory}`);
}
