// Package mcp exposes atlas to models over the Model Context Protocol: the in-app
// assistant and any external client (Claude Code, Claude Desktop) drive the same tools.
//
// The surface is deliberately read-and-propose. Nothing here runs a workflow, applies an
// action, re-segments a session, exports, or edits the taxonomy — a tool that is not in
// tools/list cannot be talked into firing, which is a stronger guarantee than a tool
// that is present and guarded.
package mcp

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"

	"atlas/backend/internal/config"
	"atlas/backend/internal/modelclient"
	"atlas/backend/internal/nodes"
	"atlas/backend/internal/primitives"
	"atlas/backend/internal/projects"
	"atlas/backend/internal/sessions"
	"atlas/backend/internal/sheet"
	"atlas/backend/internal/store"
	"atlas/backend/internal/workers"
)

// Tool is one callable exposed to a model.
type Tool struct {
	Name        string
	Description string
	Schema      map[string]any
	Call        func(ctx context.Context, args Args) (Result, error)
}

// Result is a tool's answer. Data is rendered as JSON for the model to read; Image
// carries a rendered picture for the tools whose answer is something to look at.
type Result struct {
	Data  any
	Image *Image
}

// Image is a picture a tool returns, inline and base64-encoded per the protocol.
type Image struct {
	Base64 string
	MIME   string
}

func data(value any) (Result, error) { return Result{Data: value}, nil }

// Registry is the tool set, in a stable order so tools/list never reshuffles.
func Registry() []Tool {
	tools := []Tool{
		listSessionsTool(), getSessionTool(), listEntitiesTool(),
		listClassesTool(), insightsTool(), predictionsTool(), proposeLabelsTool(),
		listNodeTypesTool(), listWorkflowsTool(), validateWorkflowTool(),
		dryRunWorkflowTool(), saveWorkflowTool(), contactSheetTool(),
	}
	sort.SliceStable(tools, func(a, b int) bool { return tools[a].Name < tools[b].Name })
	return tools
}

// Call runs a tool by name.
func Call(ctx context.Context, name string, args Args) (Result, error) {
	for _, tool := range Registry() {
		if tool.Name == name {
			return tool.Call(ctx, args)
		}
	}
	return Result{}, fmt.Errorf("unknown tool %q", name)
}

// schema builds a JSON Schema object for a tool's arguments.
func schema(properties map[string]any, required ...string) map[string]any {
	if required == nil {
		required = []string{}
	}
	return map[string]any{"type": "object", "properties": properties, "required": required}
}

func stringField(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func intField(description string) map[string]any {
	return map[string]any{"type": "integer", "description": description}
}

func objectField(description string) map[string]any {
	return map[string]any{"type": "object", "description": description}
}

// --- sessions ---------------------------------------------------------------

func listSessionsTool() Tool {
	return Tool{
		Name:        "list_sessions",
		Description: "List labeling sessions with their progress. Optionally scoped to one project.",
		Schema:      schema(map[string]any{"project": stringField("project id; omit for every project")}),
		Call: func(ctx context.Context, args Args) (Result, error) {
			list, err := sessions.Default.List(ctx, args.String("project"))
			if err != nil {
				return Result{}, err
			}
			return data(map[string]any{"sessions": list})
		},
	}
}

func getSessionTool() Tool {
	return Tool{
		Name:        "get_session",
		Description: "One session: its source, project, and labeling progress.",
		Schema:      schema(map[string]any{"sid": stringField("session id")}, "sid"),
		Call: func(ctx context.Context, args Args) (Result, error) {
			session, err := requireSession(ctx, args)
			if err != nil {
				return Result{}, err
			}
			status, err := sessions.Default.Status(ctx, session)
			if err != nil {
				return Result{}, err
			}
			return data(status)
		},
	}
}

func listEntitiesTool() Tool {
	return Tool{
		Name: "list_entities",
		Description: "The entities (clips or images) in a session, with status, labels and time range. " +
			"Use status to narrow: pending, labeled, skipped.",
		Schema: schema(map[string]any{
			"sid":    stringField("session id"),
			"status": stringField("only entities with this status"),
			"offset": intField("skip this many (default 0)"),
			"limit":  intField("how many to return (default 50, max 500)"),
		}, "sid"),
		Call: func(ctx context.Context, args Args) (Result, error) {
			session, err := requireSession(ctx, args)
			if err != nil {
				return Result{}, err
			}
			images, err := store.Open(session.ID, nil).All(ctx)
			if err != nil {
				return Result{}, err
			}
			matching := filterByStatus(images, args.String("status"))
			page := paginate(matching, args.Int("offset", 0), args.Int("limit", 50))
			return data(map[string]any{
				"total": len(matching), "returned": len(page), "entities": describeEntities(page),
			})
		},
	}
}

func filterByStatus(images []store.Image, status string) []store.Image {
	if status == "" {
		return images
	}
	matching := make([]store.Image, 0, len(images))
	for _, image := range images {
		if image.Status == status {
			matching = append(matching, image)
		}
	}
	return matching
}

func paginate(images []store.Image, offset, limit int) []store.Image {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	if offset < 0 || offset >= len(images) {
		return nil
	}
	return images[offset:min(offset+limit, len(images))]
}

func describeEntities(images []store.Image) []map[string]any {
	out := make([]map[string]any, 0, len(images))
	for _, image := range images {
		entity := map[string]any{
			"idx": image.Idx, "ref": image.Ref, "status": image.Status,
			"embedded": image.Embedded, "labels": primitives.LabelsOf(image.Annotations),
		}
		if image.TStart != nil && image.TEnd != nil {
			entity["t_start"], entity["t_end"] = *image.TStart, *image.TEnd
		}
		out = append(out, entity)
	}
	return out
}

// --- taxonomy and model -----------------------------------------------------

func listClassesTool() Tool {
	return Tool{
		Name:        "list_classes",
		Description: "The label taxonomy a project annotates with.",
		Schema:      schema(map[string]any{"project": stringField("project id")}, "project"),
		Call: func(ctx context.Context, args Args) (Result, error) {
			project, err := projects.Default.Get(ctx, args.String("project"))
			if err != nil || project == nil {
				return Result{}, fmt.Errorf("project not found")
			}
			return data(map[string]any{
				"project": project.ID, "content_kind": project.ContentKind(),
				"model": project.Model(), "classes": project.Classes(),
			})
		},
	}
}

func insightsTool() Tool {
	return Tool{
		Name: "get_insights",
		Description: "Cross-validated per-class metrics for a project's classifier: precision, recall, " +
			"F1, PR-AUC and support. The evidence for which classes need more labels or are being confused.",
		Schema: schema(map[string]any{"project": stringField("project id")}, "project"),
		Call: func(ctx context.Context, args Args) (Result, error) {
			raw, err := modelclient.Insights(ctx, args.String("project"))
			if err != nil {
				return Result{}, err
			}
			var decoded any
			if err := json.Unmarshal(raw, &decoded); err != nil {
				return Result{}, err
			}
			return data(decoded)
		},
	}
}

func predictionsTool() Tool {
	return Tool{
		Name: "preview_predictions",
		Description: "What the classifier would say about a session's entities. Reads only — nothing " +
			"is written, so this is how to inspect the model's opinion before proposing anything.",
		Schema: schema(map[string]any{
			"sid":   stringField("session id"),
			"limit": intField("how many entities to predict (default 20, max 200)"),
		}, "sid"),
		Call: func(ctx context.Context, args Args) (Result, error) {
			session, err := requireSession(ctx, args)
			if err != nil {
				return Result{}, err
			}
			project, err := projects.Default.Get(ctx, session.Project)
			if err != nil || project == nil {
				return Result{}, fmt.Errorf("project not found")
			}
			images, err := store.Open(session.ID, nil).PendingEmbedded(ctx)
			if err != nil {
				return Result{}, err
			}
			images = paginate(images, 0, args.Int("limit", 20))
			refs := make([]string, 0, len(images))
			for _, image := range images {
				refs = append(refs, image.Ref)
			}
			if len(refs) == 0 {
				return data(map[string]any{"predictions": []any{}, "note": "no embedded pending entities"})
			}
			predictions, err := modelclient.Predict(ctx, refs, project.Classes(), session.Project)
			if err != nil {
				return Result{}, err
			}
			return data(map[string]any{"predictions": predictions})
		},
	}
}

func proposeLabelsTool() Tool {
	return Tool{
		Name: "propose_labels",
		Description: "Write labels onto entities as PROPOSALS for a human to confirm or reject in the " +
			"grid. This never confirms a label and never trains the model.",
		Schema: schema(map[string]any{
			"sid": stringField("session id"),
			"proposals": map[string]any{
				"type":        "array",
				"description": "one entry per entity: {idx, labels[]}",
				"items": schema(map[string]any{
					"idx":    intField("entity idx"),
					"labels": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				}, "idx", "labels"),
			},
		}, "sid", "proposals"),
		Call: func(ctx context.Context, args Args) (Result, error) {
			session, err := requireSession(ctx, args)
			if err != nil {
				return Result{}, err
			}
			st := store.Open(session.ID, nil)
			written := 0
			for _, proposal := range args.List("proposals") {
				entry := Args(proposal)
				idx := entry.Int("idx", -1)
				if idx < 0 {
					continue
				}
				labels := entry.Strings("labels")
				if err := st.SetProposedAnnotations(ctx, idx, primitives.TagsToAnnotations(labels)); err != nil {
					return Result{}, err
				}
				written++
			}
			return data(map[string]any{
				"proposed": written,
				"note":     "written as proposals; they take effect only when a human confirms them",
			})
		},
	}
}

// --- workflows --------------------------------------------------------------

func listNodeTypesTool() Tool {
	return Tool{
		Name: "list_node_types",
		Description: "The workflow node catalog: every node type with its params, ports, and the " +
			"entities it accepts. This is the reference for authoring a workflow graph.",
		Schema: schema(map[string]any{"project": stringField("project id; narrows to what it can run")}),
		Call: func(ctx context.Context, args Args) (Result, error) {
			id := args.String("project")
			if id == "" {
				return data(map[string]any{"nodes": nodes.Catalog()})
			}
			project, err := projects.Default.Get(ctx, id)
			if err != nil || project == nil {
				return Result{}, fmt.Errorf("project not found")
			}
			return data(map[string]any{"nodes": nodes.CatalogFor(project.ContentKind(), project.Model())})
		},
	}
}

func listWorkflowsTool() Tool {
	return Tool{
		Name:        "list_workflows",
		Description: "Saved workflows and their graphs.",
		Schema:      schema(map[string]any{"project": stringField("project id")}),
		Call: func(ctx context.Context, args Args) (Result, error) {
			project := args.String("project")
			owned := []config.Workflow{}
			for _, workflow := range config.Get().Workflows {
				if project == "" || workflow.RunsFor(project) {
					owned = append(owned, workflow)
				}
			}
			return data(map[string]any{"workflows": owned})
		},
	}
}

func validateWorkflowTool() Tool {
	return Tool{
		Name: "validate_workflow",
		Description: "Check a workflow graph without running it: node types, wiring, cycles and params. " +
			"Call this on every graph before saving it.",
		Schema: schema(map[string]any{
			"graph":   objectField("the graph: {nodes:[{id,type,params}], edges:[{source,target}]}"),
			"project": stringField("project id, so nodes are checked against its content kind"),
		}, "graph"),
		Call: func(ctx context.Context, args Args) (Result, error) {
			graph, err := args.Graph("graph")
			if err != nil {
				return Result{}, err
			}
			contentKind, model := projectShape(ctx, args.String("project"))
			return data(workers.ValidateGraph(graph, contentKind, model))
		},
	}
}

func dryRunWorkflowTool() Tool {
	return Tool{
		Name: "dry_run_workflow",
		Description: "Report what a graph would touch in one session: how many entities reach each node " +
			"and survive it. Writes nothing and calls no plugin, so it cannot predict what a model node " +
			"would produce — it answers whether the graph is aimed at anything at all.",
		Schema: schema(map[string]any{
			"sid":   stringField("session id"),
			"graph": objectField("the graph to simulate"),
		}, "sid", "graph"),
		Call: func(ctx context.Context, args Args) (Result, error) {
			session, err := requireSession(ctx, args)
			if err != nil {
				return Result{}, err
			}
			graph, err := args.Graph("graph")
			if err != nil {
				return Result{}, err
			}
			report, err := workers.DryRun(ctx, session, graph)
			if err != nil {
				return Result{}, err
			}
			return data(report)
		},
	}
}

func saveWorkflowTool() Tool {
	return Tool{
		Name: "save_workflow",
		Description: "Save a workflow as a manual draft for a human to review and run. Triggers are " +
			"forced to manual: a saved workflow never starts on its own.",
		Schema: schema(map[string]any{
			"id":      stringField("workflow id; reuse one to replace it"),
			"label":   stringField("human-readable name"),
			"project": stringField("project that owns it"),
			"graph":   objectField("the graph"),
		}, "id", "label", "graph"),
		Call: func(ctx context.Context, args Args) (Result, error) {
			graph, err := args.Graph("graph")
			if err != nil {
				return Result{}, err
			}
			contentKind, model := projectShape(ctx, args.String("project"))
			report := workers.ValidateGraph(graph, contentKind, model)
			if !report.OK {
				return data(map[string]any{"saved": false, "report": report})
			}

			draft := config.Workflow{
				ID: args.String("id"), Label: args.String("label"),
				Project: args.String("project"), Triggers: []string{"manual"}, Graph: graph,
			}
			cfg := config.Get()
			if err := cfg.SaveWorkflows(upsert(cfg.Workflows, draft)); err != nil {
				return Result{}, err
			}
			return data(map[string]any{"saved": true, "workflow": draft, "report": report,
				"note": "saved as a manual draft; a human runs it from the workflows page"})
		},
	}
}

func upsert(list []config.Workflow, incoming config.Workflow) []config.Workflow {
	out := make([]config.Workflow, 0, len(list)+1)
	replaced := false
	for _, workflow := range list {
		if workflow.ID == incoming.ID {
			out = append(out, incoming)
			replaced = true
			continue
		}
		out = append(out, workflow)
	}
	if !replaced {
		out = append(out, incoming)
	}
	return out
}

// --- looking ----------------------------------------------------------------

func contactSheetTool() Tool {
	return Tool{
		Name: "contact_sheet",
		Description: "A grid of thumbnails from a session, as an image, plus the index saying which " +
			"entity each cell holds. One call shows what a session actually contains.",
		Schema: schema(map[string]any{
			"sid":  stringField("session id"),
			"from": intField("start at this entity position (default 0)"),
			"n":    intField("how many cells (default 24, max 48)"),
		}, "sid"),
		Call: func(ctx context.Context, args Args) (Result, error) {
			session, err := requireSession(ctx, args)
			if err != nil {
				return Result{}, err
			}
			picture, index, err := sheet.Render(ctx, session, args.Int("from", 0), args.Int("n", sheet.DefaultTiles))
			if err != nil {
				return Result{}, err
			}
			if len(index.Tiles) == 0 {
				return data(map[string]any{"tiles": 0, "note": "this session has no entities to show"})
			}
			var encoded bytes.Buffer
			if err := sheet.Encode(&encoded, picture); err != nil {
				return Result{}, err
			}
			return Result{
				Data:  index,
				Image: &Image{Base64: base64.StdEncoding.EncodeToString(encoded.Bytes()), MIME: "image/jpeg"},
			}, nil
		},
	}
}

// --- shared -----------------------------------------------------------------

func requireSession(ctx context.Context, args Args) (*sessions.Session, error) {
	sid := args.String("sid")
	if sid == "" {
		return nil, fmt.Errorf("sid is required")
	}
	session, err := sessions.Default.Get(ctx, sid)
	if err != nil {
		return nil, err
	}
	if session == nil {
		return nil, fmt.Errorf("session %q not found", sid)
	}
	return session, nil
}

// projectShape returns the content kind and model plugin a graph is judged against;
// empty strings when no project was named, which skips those checks.
func projectShape(ctx context.Context, id string) (string, string) {
	if id == "" {
		return "", ""
	}
	project, err := projects.Default.Get(ctx, id)
	if err != nil || project == nil {
		return "", ""
	}
	return project.ContentKind(), project.Model()
}
