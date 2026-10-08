import type { Workflow } from "@atlas/contracts";
import type { Tool, WorkflowsService } from "@atlas/contracts/server";
import {
  dataResult,
  defineTool,
  graphArgument,
  objectField,
  objectSchema,
  requireSession,
  stringArgument,
  stringField,
} from "./arguments";
import type { ToolServices } from "./arguments";

export interface WorkflowToolServices extends ToolServices {
  workflows: WorkflowsService;
}

function listNodeTypesTool(services: WorkflowToolServices): Tool {
  return defineTool({
    name: "list_node_types",
    description:
      "The workflow node catalog: every node type with its params, ports and accepted items. The reference for authoring a graph.",
    inputSchema: objectSchema({ project: stringField("project id; narrows to what it can run") }),
    readOnly: true,
    async run(args) {
      return dataResult({ nodes: services.workflows.nodes(stringArgument(args, "project")) });
    },
  });
}

function listWorkflowsTool(services: WorkflowToolServices): Tool {
  return defineTool({
    name: "list_workflows",
    description: "Saved workflows and their graphs.",
    inputSchema: objectSchema({ project: stringField("project id") }),
    readOnly: true,
    async run(args) {
      return dataResult({ workflows: services.workflows.list(stringArgument(args, "project")) });
    },
  });
}

function validateWorkflowTool(services: WorkflowToolServices): Tool {
  return defineTool({
    name: "validate_workflow",
    description:
      "Check a workflow graph without running it: node types, wiring, cycles and params. Call this on every graph before saving it.",
    inputSchema: objectSchema(
      {
        graph: objectField("the graph: {nodes:[{id,type,params,position}], edges:[{source,target}]}"),
        project: stringField("project id, so nodes are checked against its media kind"),
      },
      ["graph"],
    ),
    readOnly: true,
    async run(args) {
      const graph = graphArgument(args, "graph");
      return dataResult(services.workflows.validate(graph, stringArgument(args, "project")));
    },
  });
}

function dryRunWorkflowTool(services: WorkflowToolServices): Tool {
  return defineTool({
    name: "dry_run_workflow",
    description:
      "Report how many items would reach each node of a graph in one session. Writes nothing and runs no node, so it answers whether the graph is aimed at anything at all.",
    inputSchema: objectSchema({ sid: stringField("session id"), graph: objectField("the graph to simulate") }, [
      "sid",
      "graph",
    ]),
    readOnly: true,
    async run(args) {
      const session = requireSession(services, String(args.sid));
      return dataResult(await services.workflows.dryRun(session.id, graphArgument(args, "graph")));
    },
  });
}

function saveWorkflowTool(services: WorkflowToolServices): Tool {
  return defineTool({
    name: "save_workflow",
    description:
      "Save a workflow as a manual draft for a human to review and run. Triggers are forced to manual: a saved workflow never starts on its own.",
    inputSchema: objectSchema(
      {
        id: stringField("workflow id; reuse one to replace it"),
        label: stringField("human-readable name"),
        project: stringField("project that owns it"),
        graph: objectField("the graph"),
      },
      ["id", "label", "graph"],
    ),
    readOnly: false,
    async run(args) {
      const graph = graphArgument(args, "graph");
      const projectId = stringArgument(args, "project");
      const report = services.workflows.validate(graph, projectId);
      if (!report.ok) {
        return dataResult({ saved: false, report });
      }
      const draft: Workflow = { id: String(args.id), label: String(args.label), triggers: ["manual"], graph };
      if (projectId !== undefined) {
        draft.projectId = projectId;
      }
      services.workflows.save(draft);
      return dataResult({
        saved: true,
        workflow: draft,
        report,
        note: "saved as a manual draft; a human runs it from the workflows page",
      });
    },
  });
}

export function workflowTools(services: WorkflowToolServices): Tool[] {
  return [
    listNodeTypesTool(services),
    listWorkflowsTool(services),
    validateWorkflowTool(services),
    dryRunWorkflowTool(services),
    saveWorkflowTool(services),
  ];
}
