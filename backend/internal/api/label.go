package api

import (
	"context"
	"net/http"
	"sort"

	"atlas/backend/internal/hub"
	"atlas/backend/internal/labeling"
	"atlas/backend/internal/modelclient"
	"atlas/backend/internal/primitives"
	"atlas/backend/internal/projects"
	"atlas/backend/internal/sessions"
	"atlas/backend/internal/sources"
	"atlas/backend/internal/store"
	"atlas/backend/internal/workers"
)

// openStore loads a session and a store bound to its project's class list.
func openStore(ctx context.Context, sid string) (*sessions.Session, *store.Store, error) {
	session, err := sessions.Default.Get(ctx, sid)
	if err != nil || session == nil {
		return nil, nil, err
	}
	var classes []string
	if project, _ := projects.Default.Get(ctx, session.Project); project != nil {
		classes = project.Classes()
	}
	return session, store.Open(sid, classes), nil
}

func requireSession(w http.ResponseWriter, r *http.Request) (*sessions.Session, *store.Store, bool) {
	session, st, err := openStore(r.Context(), r.PathValue("sid"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return nil, nil, false
	}
	if session == nil {
		writeError(w, http.StatusNotFound, "session not found")
		return nil, nil, false
	}
	return session, st, true
}

func handleNext(w http.ResponseWriter, r *http.Request) {
	session, st, ok := requireSession(w, r)
	if !ok {
		return
	}
	idx, state := labeling.PickNext(r.Context(), session, st)
	switch state {
	case "done":
		writeJSON(w, http.StatusOK, map[string]any{"done": true})
	case "waiting":
		writeJSON(w, http.StatusOK, map[string]any{"done": false, "waiting": true})
	default:
		workers.FireImageTrigger(workers.TriggerImageOpened, session, idx)
		writeJSON(w, http.StatusOK, labeling.BuildImageResponse(r.Context(), session, st, idx))
	}
}

func handleItem(w http.ResponseWriter, r *http.Request) {
	session, st, ok := requireSession(w, r)
	if !ok {
		return
	}
	idx := pathInt(r, "image_id")
	writeJSON(w, http.StatusOK, labeling.BuildImageResponse(r.Context(), session, st, idx))
}

func handleImage(w http.ResponseWriter, r *http.Request) {
	_, st, ok := requireSession(w, r)
	if !ok {
		return
	}
	ref, err := st.Ref(r.Context(), pathInt(r, "image_id"))
	if err != nil || ref == "" {
		writeError(w, http.StatusNotFound, "image not found")
		return
	}
	serveImage(w, r, ref)
}

func handleLabel(w http.ResponseWriter, r *http.Request) {
	session, st, ok := requireSession(w, r)
	if !ok {
		return
	}
	var body struct {
		ID          int                     `json:"id"`
		Labels      []string                `json:"labels"`
		Annotations []primitives.Annotation `json:"annotations"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	annotations := body.Annotations
	if annotations == nil {
		annotations = primitives.TagsToAnnotations(body.Labels)
	}
	if err := labeling.ConfirmLabel(r.Context(), session, st, body.ID, annotations); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	hub.Default.Notify()
	workers.FireImageTrigger(workers.TriggerImageAccepted, session, body.ID)
	progress, _ := sessions.Default.Progress(r.Context(), session.ID)
	pool := 0
	if modelclient.Available() {
		pool = modelclient.PoolSize(r.Context(), session.Project)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "labeled": progress.Labeled, "poolSize": pool})
}

func handleSkip(w http.ResponseWriter, r *http.Request) {
	session, st, ok := requireSession(w, r)
	if !ok {
		return
	}
	var body struct {
		ID int `json:"id"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}
	if err := st.Skip(r.Context(), body.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	hub.Default.Notify()
	workers.FireImageTrigger(workers.TriggerImageRejected, session, body.ID)
	progress, _ := sessions.Default.Progress(r.Context(), session.ID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "skipped": progress.Skipped})
}

// handleImageDelete removes an image from the session entirely (the "D" action),
// unlike skip which keeps it as skipped.
func handleImageDelete(w http.ResponseWriter, r *http.Request) {
	session, st, ok := requireSession(w, r)
	if !ok {
		return
	}
	if err := st.Delete(r.Context(), pathInt(r, "image_id")); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	hub.Default.Notify()
	progress, _ := sessions.Default.Progress(r.Context(), session.ID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "total": progress.Total})
}

func handleImages(w http.ResponseWriter, r *http.Request) {
	session, st, ok := requireSession(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	filter := r.URL.Query().Get("filter")
	sort := r.URL.Query().Get("sort")

	images, err := st.All(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	finished := map[string]bool{store.StatusLabeled: true, store.StatusSkipped: true}
	filtered := images[:0]
	for _, image := range images {
		if filter == "unfinished" && finished[image.Status] {
			continue
		}
		filtered = append(filtered, image)
	}

	if sort == "uncertainty" && modelclient.Available() {
		filtered = rankByUncertainty(ctx, session, st, filtered)
	} else {
		// Natural order for spans is time, not insertion: a segment re-run or a trim
		// would otherwise scatter clips through the grid.
		sortSpansByTime(filtered)
	}

	out := make([]map[string]any, 0, len(filtered))
	for _, image := range filtered {
		tags := primitives.LabelsOf(image.Annotations)
		if tags == nil {
			tags = []string{}
		}
		entry := map[string]any{"id": image.Idx, "status": image.Status, "tags": tags}
		if image.TStart != nil && image.TEnd != nil {
			entry["t_start"] = *image.TStart
			entry["t_end"] = *image.TEnd
		}
		out = append(out, entry)
	}
	writeJSON(w, http.StatusOK, out)
}

// sortSpansByTime orders temporal spans by their start; plain entities keep their idx
// order at the head, so a session mixing frames and clips stays readable.
func sortSpansByTime(images []store.Image) {
	sort.SliceStable(images, func(a, b int) bool {
		first, second := images[a], images[b]
		if (first.TStart == nil) != (second.TStart == nil) {
			return first.TStart == nil
		}
		if first.TStart == nil {
			return first.Idx < second.Idx
		}
		if *first.TStart != *second.TStart {
			return *first.TStart < *second.TStart
		}
		return first.Idx < second.Idx
	})
}

// rankByUncertainty reorders the embedded images most-uncertain-first; unembedded stay at the tail.
func rankByUncertainty(ctx context.Context, session *sessions.Session, st *store.Store, images []store.Image) []store.Image {
	var embedded, rest []store.Image
	for _, image := range images {
		if image.Embedded {
			embedded = append(embedded, image)
		} else {
			rest = append(rest, image)
		}
	}
	if len(embedded) == 0 {
		return images
	}
	refs := make([]string, len(embedded))
	byRef := make(map[string]store.Image, len(embedded))
	for i, image := range embedded {
		refs[i] = image.Ref
		byRef[image.Ref] = image
	}
	order := modelclient.Rank(ctx, refs, st.Classes, session.Project)
	ranked := make([]store.Image, 0, len(embedded))
	seen := map[string]bool{}
	for _, ref := range order {
		if image, ok := byRef[ref]; ok && !seen[ref] {
			ranked = append(ranked, image)
			seen[ref] = true
		}
	}
	for _, image := range embedded {
		if !seen[image.Ref] {
			ranked = append(ranked, image)
		}
	}
	return append(ranked, rest...)
}

func handleDuplicates(w http.ResponseWriter, r *http.Request) {
	session, st, ok := requireSession(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	threshold := 0.93
	if value := queryFloat(r, "threshold"); value > 0 {
		threshold = value
	}
	images, err := st.All(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	refToIdx := map[string]int{}
	var refs []string
	for _, image := range images {
		if image.Embedded {
			refs = append(refs, image.Ref)
			refToIdx[image.Ref] = image.Idx
		}
	}
	if len(refs) < 2 || !modelclient.Available() {
		writeJSON(w, http.StatusOK, map[string]any{"clusters": []any{}, "duplicates": []int{}, "count": 0})
		return
	}
	result, err := modelclient.Duplicates(ctx, refs, threshold, session.Project)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	clusters := make([]map[string]any, 0, len(result.Clusters))
	for _, cluster := range result.Clusters {
		clusters = append(clusters, map[string]any{
			"keep": refToIdx[cluster.Keep], "dupes": mapRefs(cluster.Dupes, refToIdx),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"clusters": clusters, "duplicates": mapRefs(result.Duplicates, refToIdx), "count": result.Count,
	})
}

func mapRefs(refs []string, refToIdx map[string]int) []int {
	out := make([]int, 0, len(refs))
	for _, ref := range refs {
		out = append(out, refToIdx[ref])
	}
	return out
}

// serveImage redirects to remote refs or serves a local file, always no-store.
func serveImage(w http.ResponseWriter, r *http.Request, ref string) {
	w.Header().Set("Cache-Control", "no-store")
	if sources.IsRemote(ref) {
		http.Redirect(w, r, ref, http.StatusFound)
		return
	}
	http.ServeFile(w, r, ref)
}
