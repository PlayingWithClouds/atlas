import type { Project, Session, WorkflowGraph } from "@atlas/contracts";
import type { ItemsService, ProjectsService, Tool, ToolContent } from "@atlas/contracts/server";

export type ToolArguments = Record<string, unknown>;

export interface ToolServices {
  items: ItemsService;
  projects: ProjectsService;
}

export function dataResult(data: unknown): ToolContent[] {
  return [{ type: "text", text: JSON.stringify(data, null, 2) }];
}

export function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required };
}

export function stringField(description: string): Record<string, unknown> {
  return { type: "string", description };
}

export function integerField(description: string): Record<string, unknown> {
  return { type: "integer", description };
}

export function objectField(description: string): Record<string, unknown> {
  return { type: "object", description };
}

export function stringArgument(args: ToolArguments, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return String(value);
}

export function integerArgument(args: ToolArguments, key: string, fallback: number): number {
  const value = Number(args[key]);
  if (args[key] === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.trunc(value);
}

export function graphArgument(args: ToolArguments, key: string): WorkflowGraph {
  const value = args[key] as { nodes?: unknown; edges?: unknown } | undefined;
  if (typeof value !== "object" || value === null || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error(`${key} must be an object with nodes and edges arrays`);
  }
  return value as WorkflowGraph;
}

export function requireSession(services: ToolServices, sessionId: string): Session {
  const session = services.items.getSession(sessionId);
  if (session === undefined) {
    throw new Error(`session "${sessionId}" not found`);
  }
  return session;
}

export function requireProject(services: ToolServices, projectId: string): Project {
  const project = services.projects.get(projectId);
  if (project === undefined) {
    throw new Error(`project "${projectId}" not found`);
  }
  return project;
}

/** Clamps a page size into 1..maximum, falling back to the default when out of range. */
export function pageSize(requested: number, fallback: number, maximum: number): number {
  if (requested <= 0 || requested > maximum) {
    return fallback;
  }
  return requested;
}

export function defineTool(tool: Tool): Tool {
  return tool;
}
