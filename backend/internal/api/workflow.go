package api

import (
	"net/http"

	"atlas/backend/internal/config"
	"atlas/backend/internal/jobs"
	"atlas/backend/internal/nodes"
	"atlas/backend/internal/notifications"
	"atlas/backend/internal/projects"
	"atlas/backend/internal/sessions"
	"atlas/backend/internal/workers"
)

// handleWorkflowsList returns the saved workflows; with ?project=<id> only the ones
// that project owns (plus any not yet scoped to a project).
func handleWorkflowsList(w http.ResponseWriter, r *http.Request) {
	all := config.Get().Workflows
	project := r.URL.Query().Get("project")
	if project == "" {
		writeJSON(w, http.StatusOK, map[string]any{"workflows": all})
		return
	}
	owned := make([]config.Workflow, 0, len(all))
	for _, workflow := range all {
		if workflow.RunsFor(project) {
			owned = append(owned, workflow)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"workflows": owned})
}

// handleWorkflowNodes returns the node catalog: built-in nodes plus nodes
// advertised by currently-healthy plugins. With ?project=<id> the catalog is
// narrowed to the nodes that project can actually run.
func handleWorkflowNodes(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("project")
	if id == "" {
		writeJSON(w, http.StatusOK, map[string]any{"nodes": nodes.Catalog()})
		return
	}
	project, err := projects.Default.Get(r.Context(), id)
	if err != nil || project == nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"nodes": nodes.CatalogFor(project.ContentKind(), project.Model()),
	})
}

func handleNotificationsList(w http.ResponseWriter, r *http.Request) {
	list, _ := notifications.List(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"notifications": list})
}

// handleNotificationsClear deletes all persistent notifications.
func handleNotificationsClear(w http.ResponseWriter, r *http.Request) {
	if err := notifications.Clear(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to clear notifications")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleNotificationDismiss deletes one persistent notification by id.
func handleNotificationDismiss(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
	}
	if err := decodeJSON(r, &body); err != nil || body.ID == "" {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if err := notifications.Dismiss(r.Context(), body.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to dismiss notification")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleWorkflowSave upserts a designer-authored workflow (by id) and persists
// the whole list back to atlas.config.json.
func handleWorkflowSave(w http.ResponseWriter, r *http.Request) {
	var incoming config.Workflow
	if err := decodeJSON(r, &incoming); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if incoming.ID == "" {
		writeError(w, http.StatusBadRequest, "workflow id is required")
		return
	}

	cfg := config.Get()
	list := upsertWorkflow(cfg.Workflows, incoming)
	if err := cfg.SaveWorkflows(list); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save workflow")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "workflows": list})
}

func handleWorkflowDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("workflow_id")
	cfg := config.Get()
	list := make([]config.Workflow, 0, len(cfg.Workflows))
	for _, workflow := range cfg.Workflows {
		if workflow.ID != id {
			list = append(list, workflow)
		}
	}
	if err := cfg.SaveWorkflows(list); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete workflow")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "workflows": list})
}

func upsertWorkflow(existing []config.Workflow, incoming config.Workflow) []config.Workflow {
	list := make([]config.Workflow, len(existing))
	copy(list, existing)
	for i := range list {
		if list[i].ID == incoming.ID {
			list[i] = incoming
			return list
		}
	}
	return append(list, incoming)
}

// handleRunSessionWorkflow runs a manually-triggered workflow over a session.
// handleWorkflowValidate checks a graph without running it: node types, edges, cycles,
// and the params the designer would have constrained but an API caller can still send.
func handleWorkflowValidate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Graph   *config.WorkflowGraph `json:"graph"`
		Project string                `json:"project"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Graph == nil {
		writeError(w, http.StatusBadRequest, "invalid body: expected {graph}")
		return
	}
	contentKind, model := projectShape(r, body.Project)
	writeJSON(w, http.StatusOK, workers.ValidateGraph(body.Graph, contentKind, model))
}

// handleWorkflowDryRun reports what a graph would touch in this session. It writes
// nothing and calls no plugin, so it is safe to run on every draft.
func handleWorkflowDryRun(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Graph      *config.WorkflowGraph `json:"graph"`
		WorkflowID string                `json:"workflow_id"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	graph := body.Graph
	if graph == nil && body.WorkflowID != "" {
		if workflow := config.Get().Workflow(body.WorkflowID); workflow != nil {
			graph = workflow.Graph
		}
	}
	if graph == nil {
		writeError(w, http.StatusBadRequest, "expected {graph} or a known {workflow_id}")
		return
	}

	session, err := sessions.Default.Get(r.Context(), r.PathValue("sid"))
	if err != nil || session == nil {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	report, err := workers.DryRun(r.Context(), session, graph)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// projectShape returns the content kind and model plugin a graph will be judged against,
// or empty strings when no project was named (then those checks are skipped).
func projectShape(r *http.Request, id string) (string, string) {
	if id == "" {
		return "", ""
	}
	project, err := projects.Default.Get(r.Context(), id)
	if err != nil || project == nil {
		return "", ""
	}
	return project.ContentKind(), project.Model()
}

func handleRunSessionWorkflow(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("sid")
	workflow := config.Get().Workflow(r.PathValue("workflow_id"))
	if workflow == nil || workflow.Graph == nil {
		writeError(w, http.StatusNotFound, "unknown workflow")
		return
	}
	session, err := sessions.Default.Get(r.Context(), sid)
	if err != nil || session == nil {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	if !workflow.RunsFor(session.Project) {
		writeError(w, http.StatusBadRequest, "workflow belongs to project "+workflow.Project)
		return
	}
	if jobs.Default.Running(r.Context(), "workflow", sid) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "already_running": true})
		return
	}
	graph := workflow.Graph
	label := workflow.Label
	runCtx := workers.RunContext{Session: session, ImageIdx: -1}
	job := jobs.Default.Submit("workflow", sid, 0, map[string]any{"workflow": workflow.ID}, func(job *jobs.Job) error {
		return workers.RunAndNotify(runCtx, graph, label, job)
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "started": true, "job": job.View()})
}
