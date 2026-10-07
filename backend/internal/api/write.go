package api

import (
	"net/http"

	"atlas/backend/internal/hub"
	"atlas/backend/internal/jobs"
	"atlas/backend/internal/labeling"
	"atlas/backend/internal/projects"
	"atlas/backend/internal/sessions"
	"atlas/backend/internal/sources"
	"atlas/backend/internal/store"
	"atlas/backend/internal/workers"
)

type sessionRequest struct {
	Source          string   `json:"source"`
	Project         string   `json:"project"`
	Classes         []string `json:"classes"`
	Directory       string   `json:"directory"`
	GalleryID       string   `json:"galleryId"`
	SceneID         string   `json:"sceneId"`
	Path            string   `json:"path"`
	IntervalSeconds int      `json:"intervalSeconds"`
	Images          []string `json:"images"`
	Count           int      `json:"count"`
	ModelName       string   `json:"model_name"`
}

func (req sessionRequest) ref() string {
	switch req.Source {
	case "directory":
		return req.Directory
	case "gallery":
		return req.GalleryID
	case "video":
		return req.SceneID
	case "localvideo":
		return req.Path
	}
	return ""
}

func handleSessionCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var req sessionRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Project == "" {
		req.Project = projects.DefaultProject
	}
	if req.IntervalSeconds == 0 {
		req.IntervalSeconds = 20
	}
	if req.Count == 0 {
		req.Count = 20
	}

	project, err := projects.Default.Get(ctx, req.Project)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if project == nil {
		writeError(w, http.StatusNotFound, "unknown project: "+req.Project)
		return
	}
	classes := req.Classes
	if len(classes) == 0 {
		classes = project.Classes()
	}
	if len(classes) == 0 {
		writeError(w, http.StatusBadRequest, "project has no classes — add a label schema first")
		return
	}

	// Resume: a non-random source that already has a session reopens in place.
	if req.Source != "random" && req.ref() != "" {
		sid := sources.SessionIDFor(req.Project, req.Source, req.ref())
		if existing, _ := sessions.Default.Get(ctx, sid); existing != nil {
			workers.FireTrigger(workers.TriggerSessionCreated, existing)
			finishSessionResponse(w, r, existing)
			return
		}
	}

	resolved, ref, sid, err := sources.Resolve(ctx, sources.Input{
		Source: req.Source, Project: req.Project, Directory: req.Directory,
		GalleryID: req.GalleryID, SceneID: req.SceneID, Path: req.Path,
		IntervalSeconds: req.IntervalSeconds,
		Images:          req.Images, Count: req.Count,
	})
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	streaming := resolved.Video != nil
	if !streaming && len(resolved.Items) == 0 {
		writeError(w, http.StatusBadRequest, "source has no images")
		return
	}

	session := &sessions.Session{
		ID: sid, Project: req.Project, Source: req.Source, Ref: ref,
		Label: resolved.Label, ModelName: req.ModelName, FramesDir: resolved.FramesDir,
		Video: resolved.Video, Producing: false,
	}
	if err := sessions.Default.Insert(ctx, session, resolved.Items); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	st := store.Open(sid, classes)
	labeling.BackfillPool(ctx, session, st)

	// Video sources still ingest frames; embedding is left to workflows. A video-clip
	// project skips extraction entirely — its entities are spans cut by a segment node,
	// and mixing extracted frames into the same session muddles the grid.
	if streaming && project.ContentKind() != "video" {
		jobs.Default.Submit("extract", sid, 0, nil, func(job *jobs.Job) error {
			return workers.ExtractAndIngest(session, job)
		})
	}
	workers.FireTrigger(workers.TriggerSessionCreated, session)
	finishSessionResponse(w, r, session)
}

// handleSessionOpened / handleSessionClosed fire lifecycle triggers when the
// annotate view is entered or left.
func handleSessionOpened(w http.ResponseWriter, r *http.Request) {
	fireSessionEvent(w, r, workers.TriggerSessionOpened)
}

func handleSessionClosed(w http.ResponseWriter, r *http.Request) {
	fireSessionEvent(w, r, workers.TriggerSessionClosed)
}

func fireSessionEvent(w http.ResponseWriter, r *http.Request, trigger string) {
	session, err := sessions.Default.Get(r.Context(), r.PathValue("sid"))
	if err != nil || session == nil {
		writeError(w, http.StatusNotFound, "session not found")
		return
	}
	workers.FireTrigger(trigger, session)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func finishSessionResponse(w http.ResponseWriter, r *http.Request, session *sessions.Session) {
	hub.Default.Notify()
	status, err := sessions.Default.Status(r.Context(), session)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, status)
}
