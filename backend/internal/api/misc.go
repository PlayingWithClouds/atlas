package api

import (
	"context"
	"net/http"
	"path/filepath"

	"atlas/backend/internal/config"
	"atlas/backend/internal/db"
	"atlas/backend/internal/jobs"
	"atlas/backend/internal/modelclient"
	"atlas/backend/internal/projects"
	"atlas/backend/internal/registry"
	"atlas/backend/internal/workers"
)

// --- insights --------------------------------------------------------------

func handleInsights(w http.ResponseWriter, r *http.Request) {
	project := r.URL.Query().Get("project")
	if project == "" {
		project = projects.DefaultProject
	}
	if !modelclient.Available() {
		writeJSON(w, http.StatusOK, map[string]any{"pool": 0, "backbone": nil, "classes": []any{}})
		return
	}
	raw, err := modelclient.Insights(r.Context(), project)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}

// --- random ----------------------------------------------------------------

func handleRandomImages(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	plugin := registry.Default.SourceFor("random")
	if plugin == nil {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	count := queryInt(r, "count", 60)
	per := queryInt(r, "per", 4)

	// Exclude refs already ingested into any session so the grid shows fresh images.
	exclude := ingestedRefs(ctx)

	var result struct {
		Items []map[string]any `json:"items"`
	}
	if err := pluginCall(ctx, plugin.ID, "source.sample",
		map[string]any{"count": count, "per": per, "exclude": exclude}, &result); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if result.Items == nil {
		result.Items = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, result.Items)
}

func ingestedRefs(ctx context.Context) []string {
	rows, err := db.Query[struct {
		Ref string `json:"ref"`
	}](ctx, "SELECT ref FROM image", nil)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.Ref)
	}
	return out
}

// --- dataset export / import -----------------------------------------------

func handleDatasetExport(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	_ = decodeJSON(r, &body)
	outDir := body.Path
	if outDir == "" {
		outDir = filepath.Join(config.Get().Dir(), "dataset")
	}
	if jobs.Default.Running(r.Context(), "export", "") {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "already_running": true, "dir": outDir})
		return
	}
	job := jobs.Default.Submit("export", "", 0, map[string]any{"dir": outDir}, func(job *jobs.Job) error {
		return workers.ExportDataset(outDir, job)
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "started": true, "dir": outDir, "job": job.View()})
}

func handleDatasetImport(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	_ = decodeJSON(r, &body)
	inDir := body.Path
	if inDir == "" {
		inDir = filepath.Join(config.Get().Dir(), "dataset")
	}
	if jobs.Default.Running(r.Context(), "import", "") {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "already_running": true, "dir": inDir})
		return
	}
	job := jobs.Default.Submit("import", "", 0, map[string]any{"dir": inDir}, func(job *jobs.Job) error {
		return workers.ImportDataset(inDir, job)
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "started": true, "dir": inDir, "job": job.View()})
}
