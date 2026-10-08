import type { Annotation, Item, Project } from "@atlas/contracts";
import type { ModelsService, PrimitivesService, Tool } from "@atlas/contracts/server";
import { classNamesOf } from "@atlas/contracts";
import { labelsOf } from "../nodes/filter";
import {
  dataResult,
  defineTool,
  integerArgument,
  integerField,
  objectSchema,
  pageSize,
  requireProject,
  requireSession,
  stringArgument,
  stringField,
} from "./arguments";
import type { ToolArguments, ToolServices } from "./arguments";

export interface SessionToolServices extends ToolServices {
  models: ModelsService;
  primitives: PrimitivesService;
}

function describeItem(item: Item): Record<string, unknown> {
  return {
    id: item.id,
    index: item.index,
    ref: item.ref,
    status: item.status,
    embedded: item.embedded,
    labels: labelsOf(item.annotations),
    span: item.span,
  };
}

function listSessionsTool(services: SessionToolServices): Tool {
  return defineTool({
    name: "list_sessions",
    description: "List labeling sessions with their progress. Optionally scoped to one project.",
    inputSchema: objectSchema({ project: stringField("project id; omit for every project") }),
    readOnly: true,
    async run(args) {
      return dataResult({ sessions: services.items.summaries(stringArgument(args, "project")) });
    },
  });
}

function getSessionTool(services: SessionToolServices): Tool {
  return defineTool({
    name: "get_session",
    description: "One session: its source, project and labeling progress.",
    inputSchema: objectSchema({ sid: stringField("session id") }, ["sid"]),
    readOnly: true,
    async run(args) {
      const session = requireSession(services, String(args.sid));
      return dataResult(await services.items.status(session.id));
    },
  });
}

function listItemsTool(services: SessionToolServices): Tool {
  return defineTool({
    name: "list_items",
    description: "The items in a session with status, labels and time range. Use status to narrow: pending, labeled, skipped.",
    inputSchema: objectSchema(
      {
        sid: stringField("session id"),
        status: stringField("only items with this status"),
        offset: integerField("skip this many (default 0)"),
        limit: integerField("how many to return (default 50, max 500)"),
      },
      ["sid"],
    ),
    readOnly: true,
    async run(args) {
      const session = requireSession(services, String(args.sid));
      const status = stringArgument(args, "status");
      const matching = services.items.list(session.id).filter((item) => status === undefined || item.status === status);
      const offset = Math.max(0, integerArgument(args, "offset", 0));
      const limit = pageSize(integerArgument(args, "limit", 50), 50, 500);
      const page = matching.slice(offset, offset + limit);
      return dataResult({ total: matching.length, returned: page.length, items: page.map(describeItem) });
    },
  });
}

function listClassesTool(services: SessionToolServices): Tool {
  return defineTool({
    name: "list_classes",
    description: "The label taxonomy a project annotates with.",
    inputSchema: objectSchema({ project: stringField("project id") }, ["project"]),
    readOnly: true,
    async run(args) {
      const project = requireProject(services, String(args.project));
      return dataResult({
        project: project.id,
        mediaKind: project.config.mediaKind,
        model: project.config.model,
        primitives: project.config.primitives,
        classes: classNamesOf(project.config),
        groups: project.config.labels.groups,
      });
    },
  });
}

function getInsightsTool(services: SessionToolServices): Tool {
  return defineTool({
    name: "get_insights",
    description:
      "Cross-validated per-class metrics for a project's classifier: precision, recall, F1, average precision and support.",
    inputSchema: objectSchema({ project: stringField("project id") }, ["project"]),
    readOnly: true,
    async run(args) {
      const project = requireProject(services, String(args.project));
      const provider = services.models.forProject(project);
      return dataResult(await provider.insights(project.id, classNamesOf(project.config)));
    },
  });
}

function previewPredictionsTool(services: SessionToolServices): Tool {
  return defineTool({
    name: "preview_predictions",
    description:
      "What the classifier would say about a session's pending embedded items. Reads only; nothing is written.",
    inputSchema: objectSchema(
      { sid: stringField("session id"), limit: integerField("how many items to predict (default 20, max 200)") },
      ["sid"],
    ),
    readOnly: true,
    async run(args) {
      const session = requireSession(services, String(args.sid));
      const project = requireProject(services, session.projectId);
      const limit = pageSize(integerArgument(args, "limit", 20), 20, 200);
      const candidates = services.items.list(session.id, { status: "pending", embedded: true }).slice(0, limit);
      if (candidates.length === 0) {
        return dataResult({ predictions: {}, note: "no embedded pending items" });
      }
      const provider = services.models.forProject(project);
      const refs = candidates.map((item) => item.ref);
      return dataResult({ predictions: await provider.predict(project.id, refs, classNamesOf(project.config)) });
    },
  });
}

function normalizeAnnotation(services: SessionToolServices, project: Project, candidate: unknown): Annotation | undefined {
  const { type, value } = candidate as { type?: unknown; value?: unknown };
  if (typeof type !== "string" || typeof value !== "object" || value === null) {
    return undefined;
  }
  const primitive = services.primitives.get(type);
  if (primitive === undefined) {
    return undefined;
  }
  const normalized = primitive.normalize(value as Record<string, unknown>, project);
  if (normalized === null) {
    return undefined;
  }
  return { type, value: normalized };
}

function normalizeAnnotations(services: SessionToolServices, project: Project, raw: unknown): Annotation[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const normalized: Annotation[] = [];
  for (const candidate of raw) {
    const annotation = normalizeAnnotation(services, project, candidate);
    if (annotation !== undefined) {
      normalized.push(annotation);
    }
  }
  return normalized;
}

function proposeLabelsTool(services: SessionToolServices): Tool {
  return defineTool({
    name: "propose_labels",
    description:
      "Write annotations onto pending items as PROPOSALS for a human to confirm or reject. Never confirms and never trains.",
    inputSchema: objectSchema(
      {
        sid: stringField("session id"),
        proposals: {
          type: "array",
          description: "one entry per item: {itemId, annotations: [{type, value}]}",
          items: objectSchema({ itemId: stringField("item id"), annotations: { type: "array" } }, ["itemId", "annotations"]),
        },
      },
      ["sid", "proposals"],
    ),
    readOnly: false,
    async run(args) {
      const session = requireSession(services, String(args.sid));
      const project = requireProject(services, session.projectId);
      const proposals = Array.isArray(args.proposals) ? (args.proposals as ToolArguments[]) : [];
      let proposed = 0;
      for (const proposal of proposals) {
        if (proposeOne(services, project, session.id, proposal)) {
          proposed += 1;
        }
      }
      return dataResult({ proposed, note: "written as proposals; they take effect only when a human confirms them" });
    },
  });
}

function proposeOne(services: SessionToolServices, project: Project, sessionId: string, proposal: ToolArguments): boolean {
  const item = services.items.get(String(proposal.itemId));
  if (item === undefined || item.sessionId !== sessionId) {
    return false;
  }
  const annotations = normalizeAnnotations(services, project, proposal.annotations);
  if (annotations.length === 0) {
    return false;
  }
  services.items.propose(item.id, annotations);
  return true;
}

export function sessionTools(services: SessionToolServices): Tool[] {
  return [
    listSessionsTool(services),
    getSessionTool(services),
    listItemsTool(services),
    listClassesTool(services),
    getInsightsTool(services),
    previewPredictionsTool(services),
    proposeLabelsTool(services),
  ];
}
