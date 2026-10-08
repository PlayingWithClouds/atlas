import type { Context } from "@neoworks/extension-system";
import type { Workflow, WorkflowGraph } from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import { addRoute, queryText, readJsonObject } from "../routes/helpers";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGraph(value: unknown): WorkflowGraph {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new HttpError(400, "graph must have nodes and edges arrays");
  }
  return value as unknown as WorkflowGraph;
}

function parseTriggers(value: unknown): string[] {
  if (value === undefined) {
    return ["manual"];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HttpError(400, "triggers must be an array of strings");
  }
  return value as string[];
}

function parseWorkflow(body: Record<string, unknown>): Workflow {
  if (typeof body.label !== "string" || body.label === "") {
    throw new HttpError(400, "label is required");
  }
  const workflow: Workflow = {
    id: optionalString(body.id) || crypto.randomUUID(),
    label: body.label,
    triggers: parseTriggers(body.triggers),
    graph: parseGraph(body.graph),
  };
  const projectId = optionalString(body.projectId);
  if (projectId !== undefined) {
    workflow.projectId = projectId;
  }
  return workflow;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") {
    return value;
  }
  return undefined;
}

function optionalProjectId(request: Request): string | undefined {
  return queryText(request, "projectId");
}

async function readGraphOrWorkflow(ctx: Context, body: Record<string, unknown>): Promise<WorkflowGraph> {
  if (typeof body.workflowId === "string") {
    const workflow = ctx.workflows.list().find((candidate) => candidate.id === body.workflowId);
    if (workflow === undefined) {
      throw new HttpError(404, "workflow not found");
    }
    return workflow.graph;
  }
  return parseGraph(body.graph);
}

function registerCatalogRoutes(ctx: Context): void {
  addRoute(ctx, "GET", "/api/workflows", (request) => ctx.workflows.list(optionalProjectId(request)));
  addRoute(ctx, "GET", "/api/workflows/nodes", (request) => ctx.workflows.nodes(optionalProjectId(request)));
  addRoute(ctx, "GET", "/api/workflows/triggers", () => ctx.workflows.triggers());
}

function registerEditingRoutes(ctx: Context): void {
  addRoute(ctx, "POST", "/api/workflows", async (request) => {
    const workflow = parseWorkflow(await readJsonObject(request));
    ctx.workflows.save(workflow);
    return workflow;
  });
  addRoute(ctx, "DELETE", "/api/workflows/:id", (_request, params) => {
    ctx.workflows.remove(params.id);
    return { ok: true };
  });
  addRoute(ctx, "POST", "/api/workflows/validate", async (request) => {
    const body = await readJsonObject(request);
    return ctx.workflows.validate(parseGraph(body.graph), optionalString(body.projectId));
  });
}

function registerSessionRoutes(ctx: Context): void {
  addRoute(ctx, "POST", "/api/sessions/:id/workflow/dry-run", async (request, params) => {
    const body = await readJsonObject(request);
    return ctx.workflows.dryRun(params.id, await readGraphOrWorkflow(ctx, body));
  });
  addRoute(ctx, "POST", "/api/sessions/:id/workflow/:workflowId", async (request, params) => {
    const body = await readOptionalBody(request);
    return ctx.workflows.run(params.workflowId, params.id, optionalString(body.itemId));
  });
}

async function readOptionalBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw new HttpError(400, "invalid JSON body");
  }
  return {};
}

export function registerWorkflowRoutes(ctx: Context): void {
  registerCatalogRoutes(ctx);
  registerEditingRoutes(ctx);
  registerSessionRoutes(ctx);
}
