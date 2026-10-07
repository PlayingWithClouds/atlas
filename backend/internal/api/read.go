package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"atlas/backend/internal/config"
	"atlas/backend/internal/db"
	"atlas/backend/internal/hub"
	"atlas/backend/internal/jobs"
	"atlas/backend/internal/modelclient"
	"atlas/backend/internal/projects"
	"atlas/backend/internal/registry"
	"atlas/backend/internal/sessions"
)

var knownBackbones = []string{"joytag", "vit_small_patch14_dinov2.lvd142m", "vit_base_patch14_dinov2.lvd142m"}

// --- plugins ---------------------------------------------------------------

func handlePluginsList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"plugins": registry.Default.Status()})
}

// handlePluginsReload re-reads atlas.config.json so plugin registry entries
// added while the backend is running are picked up, then re-probes everything.
func handlePluginsReload(w http.ResponseWriter, r *http.Request) {
	cfg, err := config.Reload()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reload config")
		return
	}
	registry.Default.Load(cfg.Plugins)
	writeJSON(w, http.StatusOK, map[string]any{"plugins": registry.Default.Status()})
}

// --- projects --------------------------------------------------------------

func handleProjectsList(w http.ResponseWriter, r *http.Request) {
	list, err := projects.Default.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": list})
}

func handleProjectCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name   string         `json:"name"`
		Config map[string]any `json:"config"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusBadRequest, "name required")
		return
	}
	project, err := projects.Default.Create(r.Context(), body.Name, body.Config)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, project.ToDict())
}

func handleProjectGet(w http.ResponseWriter, r *http.Request) {
	project, err := projects.Default.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if project == nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	writeJSON(w, http.StatusOK, project.ToDict())
}

func handleProjectUpdate(w http.ResponseWriter, r *http.Request) {
	var fields map[string]any
	if err := decodeJSON(r, &fields); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	project, err := projects.Default.Update(r.Context(), r.PathValue("id"), fields)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if project == nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	writeJSON(w, http.StatusOK, project.ToDict())
}

func handleProjectDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == projects.DefaultProject {
		writeError(w, http.StatusBadRequest, "cannot delete the default project")
		return
	}
	ok, err := projects.Default.Delete(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- sources ---------------------------------------------------------------

func handleSourceKinds(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var kinds []map[string]any
	for _, plugin := range registry.Default.Providers("source") {
		var result struct {
			Kinds []map[string]any `json:"kinds"`
		}
		if err := pluginCall(ctx, plugin.ID, "source.kinds", nil, &result); err == nil && result.Kinds != nil {
			for _, kind := range result.Kinds {
				kind["plugin"] = plugin.ID
				kinds = append(kinds, kind)
			}
			continue
		}
		// Fallback: derive kinds from the declared capability.
		for _, capability := range plugin.Capabilities {
			if name, _ := capability["name"].(string); name != "source" {
				continue
			}
			browsable, _ := capability["browsable"].(bool)
			if raw, ok := capability["kinds"].([]any); ok {
				for _, item := range raw {
					if id, ok := item.(string); ok {
						kinds = append(kinds, map[string]any{
							"id": id, "label": id, "plugin": plugin.ID, "browsable": browsable,
						})
					}
				}
			}
		}
	}
	if kinds == nil {
		kinds = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"kinds": kinds})
}

func handleSourceItems(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	plugin := registry.Default.SourceFor(kind)
	if plugin == nil {
		writeError(w, http.StatusNotFound, "no source plugin for kind: "+kind)
		return
	}
	params := map[string]any{
		"kind":   kind,
		"search": r.URL.Query().Get("search"),
		"limit":  queryInt(r, "limit", 40),
		"offset": queryInt(r, "offset", 0),
	}
	raw, err := registry.Default.Call(r.Context(), plugin.ID, "source.list", params, pluginTimeout)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

// --- config ----------------------------------------------------------------

func handleConfigGet(w http.ResponseWriter, r *http.Request) {
	cfg := config.Get()
	writeJSON(w, http.StatusOK, map[string]any{
		"title":           cfg.Title,
		"primitives":      cfg.Primitives,
		"labels":          json.RawMessage(cfg.Labels),
		"default_classes": cfg.DefaultClasses(),
		"backbone":        currentBackbone(r.Context()),
		"backbones":       knownBackbones,
	})
}

func handleConfigPost(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Backbone string `json:"backbone"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if body.Backbone != "" {
		for _, known := range knownBackbones {
			if known == body.Backbone {
				_ = db.SetSetting(r.Context(), "backbone", body.Backbone)
				break
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "backbone": currentBackbone(r.Context())})
}

// currentBackbone prefers the persisted setting, else the model plugin's declared backbone.
func currentBackbone(ctx context.Context) string {
	if value, ok := db.GetSetting(ctx, "backbone"); ok && value != "" {
		return value
	}
	if plugin := registry.Default.Provider("model"); plugin != nil {
		for _, capability := range plugin.Capabilities {
			if backbone, ok := capability["backbone"].(string); ok && backbone != "" {
				return backbone
			}
		}
	}
	return "joytag"
}

// --- jobs ------------------------------------------------------------------

func handleJobsList(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("session_id")
	active := r.URL.Query().Get("active") == "true"
	list, err := jobs.Default.List(r.Context(), sessionID, active)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func handleJobGet(w http.ResponseWriter, r *http.Request) {
	job, err := jobs.Default.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if job == nil {
		writeError(w, http.StatusNotFound, "job not found")
		return
	}
	writeJSON(w, http.StatusOK, job)
}

// --- stats -----------------------------------------------------------------

// handleStats reports one project's numbers. Every count is scoped to it: projects keep
// separate pools and data, so mixing them made the overview meaningless.
func handleStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	project := r.URL.Query().Get("project")
	if project == "" {
		project = projects.DefaultProject
	}
	pool := 0
	if modelclient.Available() {
		pool = modelclient.PoolSize(ctx, project)
	}

	sids := sessionIDsOf(ctx, project)
	imagesTotal, labeled := 0, 0
	if len(sids) > 0 {
		statusRows, _ := db.Query[struct {
			Status string `json:"status"`
			Count  int    `json:"count"`
		}](ctx, "SELECT status, count() AS count FROM image WHERE session IN $sids GROUP BY status",
			map[string]any{"sids": sids})
		for _, row := range statusRows {
			imagesTotal += row.Count
			if row.Status == "labeled" {
				labeled = row.Count
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"pool":        pool,
		"backbone":    currentBackbone(ctx),
		"sessions":    len(sids),
		"images":      imagesTotal,
		"labeled":     labeled,
		"processing":  0,
		"jobs_active": activeJobsFor(ctx, sids),
	})
}

// sessionIDsOf lists the session ids belonging to a project.
func sessionIDsOf(ctx context.Context, project string) []string {
	rows, err := db.Query[struct {
		ID string `json:"id"`
	}](ctx, "SELECT meta::id(id) AS id FROM session WHERE project=$project",
		map[string]any{"project": project})
	if err != nil {
		return nil
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return ids
}

// activeJobsFor counts running jobs for a project's sessions. Jobs with no session
// (dataset import/export) are global and deliberately left out.
func activeJobsFor(ctx context.Context, sids []string) int {
	if len(sids) == 0 {
		return 0
	}
	rows, err := db.Query[struct {
		Count int `json:"count"`
	}](ctx, "SELECT count() AS count FROM job WHERE state='running' AND session_id IN $sids GROUP ALL",
		map[string]any{"sids": sids})
	if err != nil || len(rows) == 0 {
		return 0
	}
	return rows[0].Count
}

func countAll(ctx context.Context, table string) int {
	rows, err := db.Query[struct {
		Count int `json:"count"`
	}](ctx, "SELECT count() AS count FROM "+table+" GROUP ALL", nil)
	if err != nil || len(rows) == 0 {
		return 0
	}
	return rows[0].Count
}

func countWhere(ctx context.Context, table, condition string) int {
	rows, err := db.Query[struct {
		Count int `json:"count"`
	}](ctx, "SELECT count() AS count FROM "+table+" WHERE "+condition+" GROUP ALL", nil)
	if err != nil || len(rows) == 0 {
		return 0
	}
	return rows[0].Count
}

// --- sessions --------------------------------------------------------------

func handleSessionsList(w http.ResponseWriter, r *http.Request) {
	list, err := sessions.Default.List(r.Context(), r.URL.Query().Get("project"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func handleSessionGet(w http.ResponseWriter, r *http.Request) {
	session, err := sessions.Default.Get(r.Context(), r.PathValue("sid"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if session == nil {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	status, err := sessions.Default.Status(r.Context(), session)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func handleSessionDelete(w http.ResponseWriter, r *http.Request) {
	if err := sessions.Default.Remove(r.Context(), r.PathValue("sid")); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Every open tab lists sessions off the live snapshot; without this the removed
	// one lingers until something else changes.
	hub.Default.Notify()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func pathInt(r *http.Request, key string) int {
	value, _ := strconv.Atoi(r.PathValue(key))
	return value
}

func queryFloat(r *http.Request, key string) float64 {
	value, err := strconv.ParseFloat(r.URL.Query().Get(key), 64)
	if err != nil {
		return 0
	}
	return value
}

func queryInt(r *http.Request, key string, fallback int) int {
	value := r.URL.Query().Get(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}
