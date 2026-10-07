package api

import (
	"net/http"

	"atlas/backend/internal/modelclient"
	"atlas/backend/internal/store"
)

// searchHit is one matching entity, in the terms the grid works in.
type searchHit struct {
	Idx    int     `json:"idx"`
	Ref    string  `json:"ref"`
	Score  float64 `json:"score"`
	Status string  `json:"status"`
}

// handleSessionSearch ranks a session's entities against a free-text query, using the
// backbone's text tower against vectors that already exist. It is a search, not a
// labeler: it returns an order, and the human decides what it means.
func handleSessionSearch(w http.ResponseWriter, r *http.Request) {
	session, st, ok := requireSession(w, r)
	if !ok {
		return
	}
	query := r.URL.Query().Get("q")
	if query == "" {
		writeError(w, http.StatusBadRequest, "q is required")
		return
	}
	if !modelclient.Available() {
		writeError(w, http.StatusServiceUnavailable, "no model plugin is connected")
		return
	}

	images, err := st.All(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	refs := make([]string, 0, len(images))
	for _, image := range images {
		refs = append(refs, image.Ref)
	}

	result, err := modelclient.Search(r.Context(), query, refs, session.Project, intQuery(r, "limit", 60))
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"query":      query,
		"hits":       hitsForImages(result.Results, images),
		"scored":     result.Scored,
		"unembedded": result.Unembedded,
		"message":    result.Message,
	})
}

// hitsForImages maps the plugin's ref-and-score answer back onto session entities,
// preserving the order it returned.
func hitsForImages(results []modelclient.SearchHit, images []store.Image) []searchHit {
	byRef := make(map[string]store.Image, len(images))
	for _, image := range images {
		byRef[image.Ref] = image
	}
	hits := make([]searchHit, 0, len(results))
	for _, result := range results {
		image, known := byRef[result.Ref]
		if !known {
			continue
		}
		hits = append(hits, searchHit{
			Idx: image.Idx, Ref: image.Ref, Score: result.Score, Status: image.Status,
		})
	}
	return hits
}
