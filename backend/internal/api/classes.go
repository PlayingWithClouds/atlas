package api

import (
	"net/http"
	"sync"
	"time"

	"atlas/backend/internal/db"
	"atlas/backend/internal/primitives"
	"atlas/backend/internal/sessions"
	"atlas/backend/internal/sources"
	"atlas/backend/internal/store"
)

// Class thumbnails are drawn from the dataset itself: a labeled entity carrying a
// class becomes that class's thumbnail. The lookup is cached briefly, per project,
// so listing and serving don't rescan on every request.
var (
	classRefsMu    sync.Mutex
	classRefsCache map[string]map[string]classExample
	classRefsAt    map[string]time.Time
)

const classRefsTTL = 30 * time.Second

// classExample is one labeled entity standing in for a class. The session comes
// along because a temporal span is not a file: serving it means finding the poster
// cut for that session's video.
type classExample struct {
	Ref     string
	Session string
}

type labeledRow struct {
	Ref         string                  `json:"ref"`
	Session     string                  `json:"session"`
	Annotations []primitives.Annotation `json:"annotations"`
}

// classRefs maps each class to a labeled example. Scoped to a project, because an
// example from another project illustrates a different taxonomy on different media —
// a clip project showed stills from the image project's gallery.
func classRefs(r *http.Request, project string) map[string]classExample {
	classRefsMu.Lock()
	defer classRefsMu.Unlock()
	if classRefsCache == nil {
		classRefsCache = map[string]map[string]classExample{}
		classRefsAt = map[string]time.Time{}
	}
	if cached, ok := classRefsCache[project]; ok && time.Since(classRefsAt[project]) < classRefsTTL {
		return cached
	}

	examples := map[string]classExample{}
	rows, err := db.Query[labeledRow](r.Context(),
		"SELECT ref, session, annotations FROM image WHERE status='labeled'", nil)
	if err == nil {
		wanted := sessionsInProject(r, project)
		for _, row := range rows {
			if wanted != nil && !wanted[row.Session] {
				continue
			}
			for _, label := range primitives.LabelsOf(row.Annotations) {
				if _, seen := examples[label]; !seen {
					examples[label] = classExample{Ref: row.Ref, Session: row.Session}
				}
			}
		}
	}
	classRefsCache[project] = examples
	classRefsAt[project] = time.Now()
	return examples
}

// sessionsInProject returns the session ids belonging to a project, or nil when no
// project was asked for (every session counts).
func sessionsInProject(r *http.Request, project string) map[string]bool {
	if project == "" {
		return nil
	}
	ids, err := sessions.Default.IDsIn(r.Context(), project)
	if err != nil {
		return map[string]bool{}
	}
	return ids
}

// handleClassThumbnails returns, per class that has a labeled example, a URL that
// serves a representative image from the dataset.
func handleClassThumbnails(w http.ResponseWriter, r *http.Request) {
	project := r.URL.Query().Get("project")
	out := map[string]string{}
	for class := range classRefs(r, project) {
		url := "/api/classes/" + class + "/thumb"
		if project != "" {
			url += "?project=" + project
		}
		out[class] = url
	}
	writeJSON(w, http.StatusOK, map[string]any{"thumbnails": out})
}

// handleClassThumb serves the representative image for a class.
func handleClassThumb(w http.ResponseWriter, r *http.Request) {
	example := classRefs(r, r.URL.Query().Get("project"))[r.PathValue("class")]
	if example.Ref == "" {
		writeError(w, http.StatusNotFound, "no example for class")
		return
	}
	// A span ref names a time range, not a file, so ServeFile would 404 on it. The
	// poster cut for that range is the frame the grid already shows for the clip.
	if poster, ok := spanPoster(r, example); ok {
		w.Header().Set("Cache-Control", "private, max-age=300")
		http.ServeFile(w, r, poster)
		return
	}
	serveImage(w, r, example.Ref)
}

// spanPoster resolves a temporal span example to a cached poster frame.
func spanPoster(r *http.Request, example classExample) (string, bool) {
	_, start, end, isSpan := store.SplitSpanRef(example.Ref)
	if !isSpan || example.Session == "" {
		return "", false
	}
	session, err := sessions.Default.Get(r.Context(), example.Session)
	if err != nil || session == nil {
		return "", false
	}
	spec := sources.SpecFrom(session.Video)
	if spec == nil {
		return "", false
	}
	return sources.EnsurePoster(spec, session.ID, example.Ref, start, end)
}
