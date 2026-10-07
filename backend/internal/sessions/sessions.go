// Package sessions is the session registry, backed by the `session` and `image` tables in
// SurrealDB. Multiple sources can be open at once; each session bundles its source metadata
// and (for streaming video) an extraction spec. A restart reloads straight from Surreal —
// no rehydrate-from-JSON dance.
package sessions

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"atlas/backend/internal/db"
	"atlas/backend/internal/modelclient"
	"atlas/backend/internal/projects"
	"atlas/backend/internal/sources"
	"atlas/backend/internal/store"
)

// Session is a stored labeling session.
type Session struct {
	ID        string         `json:"id"`
	Project   string         `json:"project"`
	Source    string         `json:"source"` // kind: directory | gallery | video | random
	Ref       string         `json:"ref"`
	Label     string         `json:"label"`
	ModelName string         `json:"model_name"`
	FramesDir string         `json:"frames_dir"`
	Video     map[string]any `json:"video"`
	Producing bool           `json:"producing"`
	Created   float64        `json:"created"`
	// Segment fingerprints the settings this session's clips were cut with, so a segment
	// node that has been retuned can tell that every boundary moved.
	Segment string `json:"segment"`
}

// Manager is the session registry over SurrealDB.
type Manager struct{}

// Default is the process-wide session manager.
var Default = &Manager{}

const selectFields = "SELECT meta::id(id) AS id, project, source, ref, label, model_name, frames_dir, video, producing, created, segment FROM session"

// IDsIn returns the session ids belonging to a project. Cheaper than List, which
// computes per-session progress the caller may not want.
func (m *Manager) IDsIn(ctx context.Context, project string) (map[string]bool, error) {
	rows, err := db.Query[Session](ctx,
		"SELECT meta::id(id) AS id FROM session WHERE project=$project",
		map[string]any{"project": project})
	if err != nil {
		return nil, err
	}
	ids := make(map[string]bool, len(rows))
	for i := range rows {
		ids[rows[i].ID] = true
	}
	return ids, nil
}

// Get returns a session by id, or nil.
func (m *Manager) Get(ctx context.Context, sid string) (*Session, error) {
	rows, err := db.Query[Session](ctx, selectFields+" WHERE id=type::record('session', $sid)", map[string]any{"sid": sid})
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

// Insert creates a session record and bulk-inserts its initial image rows.
func (m *Manager) Insert(ctx context.Context, session *Session, refs []string) error {
	if err := db.Exec(ctx,
		"CREATE type::record('session', $sid) SET project=$project, source=$source, ref=$ref, label=$label, model_name=$model_name, frames_dir=$frames_dir, video=$video, producing=$producing, created=$created",
		map[string]any{
			"sid": session.ID, "project": session.Project, "source": session.Source,
			"ref": session.Ref, "label": session.Label, "model_name": session.ModelName,
			"frames_dir": session.FramesDir, "video": session.Video,
			"producing": session.Producing, "created": float64(time.Now().Unix()),
		}); err != nil {
		return err
	}
	return store.InsertImages(ctx, session.ID, refs)
}

// SetProducing flags whether a streaming session is still ingesting frames.
func (m *Manager) SetProducing(ctx context.Context, sid string, producing bool) error {
	return db.Exec(ctx, "UPDATE type::record('session', $sid) SET producing=$producing",
		map[string]any{"sid": sid, "producing": producing})
}

// SetVideo replaces a session's video spec — used when the stream URL is
// re-resolved or the source turns out not to answer byte ranges.
func (m *Manager) SetVideo(ctx context.Context, sid string, spec map[string]any) error {
	return db.Exec(ctx, "UPDATE type::record('session', $sid) SET video=$video",
		map[string]any{"sid": sid, "video": spec})
}

// SetSegment records the settings a session's clips were cut with, so the segment node
// can tell an unchanged re-run from a retuned one.
func (m *Manager) SetSegment(ctx context.Context, sid, fingerprint string) error {
	return db.Exec(ctx, "UPDATE type::record('session', $sid) SET segment=$segment",
		map[string]any{"sid": sid, "segment": fingerprint})
}

// Remove deletes a session and all its images.
func (m *Manager) Remove(ctx context.Context, sid string) error {
	if err := db.Exec(ctx, "DELETE image WHERE session=$sid", map[string]any{"sid": sid}); err != nil {
		return err
	}
	// Clip posters are pure cache keyed by this session; nothing else reads them.
	_ = os.RemoveAll(filepath.Join(sources.CacheRoot, "posters", sid))
	return db.Exec(ctx, "DELETE type::record('session', $sid)", map[string]any{"sid": sid})
}

// Progress is a session's labeling progress, read off the image table.
type Progress struct {
	Total    int  `json:"total"`
	Labeled  int  `json:"labeled"`
	Skipped  int  `json:"skipped"`
	Embedded int  `json:"embedded"`
	Started  bool `json:"started"`
	Done     bool `json:"done"`
}

type countRow struct {
	Status string `json:"status"`
	Count  int    `json:"count"`
}

// Progress computes counts by status for a session.
func (m *Manager) Progress(ctx context.Context, sid string) (Progress, error) {
	rows, err := db.Query[countRow](ctx,
		"SELECT status, count() AS count FROM image WHERE session=$sid GROUP BY status",
		map[string]any{"sid": sid})
	if err != nil {
		return Progress{}, err
	}
	var progress Progress
	for _, row := range rows {
		switch row.Status {
		case "labeled":
			progress.Labeled = row.Count
		case "skipped":
			progress.Skipped = row.Count
		}
		progress.Total += row.Count
	}

	embeddedRows, err := db.Query[struct {
		Count int `json:"count"`
	}](ctx, "SELECT count() AS count FROM image WHERE session=$sid AND embedded=true GROUP ALL", map[string]any{"sid": sid})
	if err == nil && len(embeddedRows) > 0 {
		progress.Embedded = embeddedRows[0].Count
	}

	progress.Started = progress.Labeled > 0 || progress.Skipped > 0
	progress.Done = progress.Total > 0 && progress.Labeled+progress.Skipped >= progress.Total
	return progress, nil
}

// List returns session summaries (optionally filtered to one project), with progress.
func (m *Manager) List(ctx context.Context, project string) ([]map[string]any, error) {
	query := selectFields
	vars := map[string]any{}
	if project != "" {
		query += " WHERE project=$project"
		vars["project"] = project
	}
	rows, err := db.Query[Session](ctx, query, vars)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(rows))
	for i := range rows {
		session := rows[i]
		progress, _ := m.Progress(ctx, session.ID)
		out = append(out, map[string]any{
			"id": session.ID, "label": session.Label, "source": session.Source,
			"ref": session.Ref, "project": session.Project, "producing": session.Producing,
			"total": progress.Total, "labeled": progress.Labeled, "skipped": progress.Skipped,
			"started": progress.Started, "done": progress.Done,
		})
	}
	sort.Slice(out, func(a, b int) bool {
		return strings.ToLower(out[a]["label"].(string)) < strings.ToLower(out[b]["label"].(string))
	})
	return out, nil
}

// Status builds the full status object for GET /api/sessions/{sid}.
func (m *Manager) Status(ctx context.Context, session *Session) (map[string]any, error) {
	progress, err := m.Progress(ctx, session.ID)
	if err != nil {
		return nil, err
	}
	var classes []string
	headTrained := false
	project, _ := projects.Default.Get(ctx, session.Project)
	if project != nil {
		classes = project.Classes()
	}
	pool := 0
	if modelclient.Available() {
		pool = modelclient.PoolSize(ctx, session.Project)
		if project != nil && project.IsTag() {
			if status, statusErr := modelclient.StatusOf(ctx, classes, session.Project); statusErr == nil {
				headTrained = status.Trained
			}
		}
	}
	contentKind := "image"
	if project != nil {
		contentKind = project.ContentKind()
	}
	status := map[string]any{
		"id": session.ID, "source": session.Source, "ref": session.Ref,
		"project": session.Project, "label": session.Label, "classes": classes,
		"total": progress.Total, "embedded": progress.Embedded, "labeled": progress.Labeled,
		"skipped": progress.Skipped, "head_trained": headTrained,
		"token": 1, "pool": pool, "producing": session.Producing,
		"content_kind": contentKind,
	}
	// The playable URL is the backend's own proxy, never the resolved stream URL:
	// the CDN headers cannot travel with a browser request.
	if spec := sources.SpecFrom(session.Video); spec != nil {
		status["video"] = map[string]any{
			"url":      "/api/sessions/" + session.ID + "/video",
			"duration": spec.Duration,
			"playback": spec.Playback,
		}
	}
	return status, nil
}
