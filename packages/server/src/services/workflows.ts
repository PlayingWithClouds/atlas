import { Service } from "@neoworks/extension-system";
import type { Context } from "@neoworks/extension-system";
import type {
  GraphReport,
  JobView,
  NodeSpec,
  Project,
  Session,
  TriggerSpec,
  Workflow,
  WorkflowGraph,
} from "@atlas/contracts";
import { HttpError } from "@atlas/contracts/server";
import type { Dispose, DryRunReport, NodeType, TriggerEvent, WorkflowsService } from "@atlas/contracts/server";
import { dryRunGraph } from "./workflows/dryRun";
import { executeGraph } from "./workflows/executor";
import type { ExecutorEnvironment } from "./workflows/executor";
import { appliesToMediaKind, validateGraph } from "./workflows/graph";
import { registerWorkflowRoutes } from "./workflows/routes";
import { toWorkItem } from "./workflows/stream";

function registerUnique<Entry>(entries: Map<string, Entry>, key: string, entry: Entry, noun: string): Dispose {
  if (entries.has(key)) {
    throw new Error(`${noun} "${key}" is already registered`);
  }
  entries.set(key, entry);
  return () => {
    if (entries.get(key) === entry) {
      entries.delete(key);
    }
  };
}

function toNodeSpec(nodeType: NodeType): NodeSpec {
  const { run, dryRun, ...spec } = nodeType;
  return spec;
}

export class WorkflowsCore extends Service implements WorkflowsService {
  static inject = ["workspace", "jobs", "notifications", "live", "items", "projects", "labeling", "http"];

  private readonly nodeTypes = new Map<string, NodeType>();
  private readonly triggerSpecs = new Map<string, TriggerSpec>();
  private readonly runningKeys = new Set<string>();
  private readonly actingItemIds = new Set<string>();

  constructor(ctx: Context) {
    super(ctx, "workflows");
    this.ctx.effect(() => () => this.clear(), "workflows:registries");
    registerWorkflowRoutes(this.ctx);
  }

  registerNode(nodeType: NodeType): Dispose {
    return registerUnique(this.nodeTypes, nodeType.type, nodeType, "node type");
  }

  registerTrigger(trigger: TriggerSpec): Dispose {
    return registerUnique(this.triggerSpecs, trigger.id, trigger, "trigger");
  }

  nodes(projectId?: string): NodeSpec[] {
    const specs = [...this.nodeTypes.values()].map(toNodeSpec);
    const project = this.findProject(projectId);
    if (project === undefined) {
      return specs;
    }
    return specs.filter((spec) => appliesToMediaKind(spec, project.config.mediaKind));
  }

  triggers(): TriggerSpec[] {
    return [...this.triggerSpecs.values()];
  }

  list(projectId?: string): Workflow[] {
    const workflows = this.ctx.workspace.config().workflows;
    if (projectId === undefined) {
      return workflows;
    }
    return workflows.filter((workflow) => workflow.projectId === undefined || workflow.projectId === projectId);
  }

  save(workflow: Workflow): void {
    const config = this.ctx.workspace.config();
    const replaced = config.workflows.some((existing) => existing.id === workflow.id);
    let others = config.workflows.map((existing) => {
      if (existing.id === workflow.id) {
        return workflow;
      }
      return existing;
    });
    if (!replaced) {
      others = [...others, workflow];
    }
    this.ctx.workspace.saveConfig({ ...config, workflows: others });
  }

  remove(workflowId: string): void {
    const config = this.ctx.workspace.config();
    const remaining = config.workflows.filter((workflow) => workflow.id !== workflowId);
    this.ctx.workspace.saveConfig({ ...config, workflows: remaining });
  }

  validate(graph: WorkflowGraph, projectId?: string): GraphReport {
    const project = this.findProject(projectId);
    let mediaKind: string | undefined;
    if (project !== undefined) {
      mediaKind = project.config.mediaKind;
    }
    return validateGraph(graph, (nodeType) => this.nodeTypes.get(nodeType), mediaKind);
  }

  async dryRun(sessionId: string, graph: WorkflowGraph): Promise<DryRunReport> {
    const session = this.requireSession(sessionId);
    const project = this.requireProject(session);
    const sessionItems = () => this.ctx.items.list(sessionId).map(toWorkItem);
    return dryRunGraph({
      project,
      session,
      graph,
      entities: sessionItems(),
      findNode: (nodeType) => this.nodeTypes.get(nodeType),
      sessionItems,
    });
  }

  run(workflowId: string, sessionId: string, itemId?: string, trigger?: string): JobView {
    const workflow = this.list().find((candidate) => candidate.id === workflowId);
    if (workflow === undefined) {
      throw new HttpError(404, "workflow not found");
    }
    const session = this.requireSession(sessionId);
    const project = this.requireProject(session);
    const runKey = `${workflowId}:${sessionId}`;
    if (this.runningKeys.has(runKey)) {
      throw new HttpError(409, `workflow "${workflow.label}" is already running for this session`);
    }
    this.runningKeys.add(runKey);
    return this.submitRun(workflow, session, project, runKey, itemId, trigger);
  }

  fire(event: TriggerEvent): void {
    if (event.sessionId === undefined) {
      return;
    }
    if (event.itemId !== undefined && this.actingItemIds.has(event.itemId)) {
      return;
    }
    const session = this.ctx.items.getSession(event.sessionId);
    if (session === undefined) {
      return;
    }
    const itemId = this.scopedItemIdFor(event);
    for (const workflow of this.list(session.projectId)) {
      if (workflow.triggers.includes(event.trigger)) {
        this.startFromTrigger(workflow, session.id, itemId, event.trigger);
      }
    }
  }

  // --- internals ---------------------------------------------------------------------

  private clear(): void {
    this.nodeTypes.clear();
    this.triggerSpecs.clear();
  }

  private scopedItemIdFor(event: TriggerEvent): string | undefined {
    const trigger = this.triggerSpecs.get(event.trigger);
    if (trigger !== undefined && trigger.scope === "item") {
      return event.itemId;
    }
    return undefined;
  }

  private startFromTrigger(workflow: Workflow, sessionId: string, itemId: string | undefined, trigger: string): void {
    try {
      this.run(workflow.id, sessionId, itemId, trigger);
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        return;
      }
      console.warn(`workflow "${workflow.id}" could not start: ${(error as Error).message}`);
    }
  }

  private findProject(projectId: string | undefined): Project | undefined {
    if (projectId === undefined) {
      return undefined;
    }
    return this.ctx.projects.get(projectId);
  }

  private requireSession(sessionId: string): Session {
    const session = this.ctx.items.getSession(sessionId);
    if (session === undefined) {
      throw new HttpError(404, "session not found");
    }
    return session;
  }

  private requireProject(session: Session): Project {
    const project = this.ctx.projects.get(session.projectId);
    if (project === undefined) {
      throw new HttpError(404, "project not found");
    }
    return project;
  }

  private environment(): ExecutorEnvironment {
    return {
      items: this.ctx.items,
      labeling: this.ctx.labeling,
      notifications: this.ctx.notifications,
      notifyLive: () => this.ctx.live.notify(),
      findNode: (nodeType) => this.nodeTypes.get(nodeType),
      actingItemIds: this.actingItemIds,
    };
  }

  private submitRun(
    workflow: Workflow,
    session: Session,
    project: Project,
    runKey: string,
    itemId: string | undefined,
    trigger: string | undefined,
  ): JobView {
    const extra: Record<string, unknown> = { workflow: workflow.id, trigger: trigger || "manual" };
    return this.ctx.jobs.submit({ type: "workflow", sessionId: session.id, extra }, async (job) => {
      try {
        await executeGraph(this.environment(), { project, session, graph: workflow.graph, scopedItemId: itemId, job });
        this.reportSuccess(workflow, session);
      } catch (error) {
        this.reportFailure(workflow, session, error);
        throw error;
      } finally {
        this.runningKeys.delete(runKey);
      }
    });
  }

  private reportSuccess(workflow: Workflow, session: Session): void {
    this.ctx.notifications.toast({
      message: `Workflow "${workflow.label}" finished`,
      sessionId: session.id,
      level: "success",
    });
  }

  private reportFailure(workflow: Workflow, session: Session, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const input = { message: `Workflow "${workflow.label}" failed: ${reason}`, sessionId: session.id, level: "error" as const };
    this.ctx.notifications.persist(input);
    this.ctx.notifications.toast(input);
  }
}

export default WorkflowsCore;
