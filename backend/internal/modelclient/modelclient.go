// Package modelclient is the typed RPC client to the `model` capability plugin (embedding
// backbone, per-project pool, classifier head, predict, rank, duplicates, insights). Vectors
// never cross the wire; every call carries a project. When no model plugin is connected the
// backend degrades gracefully (natural order, empty suggestions).
package modelclient

import (
	"context"
	"encoding/json"
	"time"

	"atlas/backend/internal/projects"
	"atlas/backend/internal/registry"
	"atlas/backend/internal/rpc"
)

const (
	Capability     = "model"
	DefaultProject = "nsfw-tags"
	// Bulk work (embedding a batch, refitting, cross-validating) is minutes-scale.
	bulkTimeout = 120 * time.Second
	// Calls a page render waits on. A wedged plugin has to fail fast here, or the UI
	// hangs instead of degrading to natural order and empty suggestions.
	readTimeout = 20 * time.Second
)

// Available reports whether a model plugin is connected.
func Available() bool {
	return registry.Default.Provider(Capability) != nil
}

func call(ctx context.Context, method string, params map[string]any) (json.RawMessage, error) {
	return callWithin(ctx, bulkTimeout, method, params)
}

func callWithin(ctx context.Context, timeout time.Duration, method string, params map[string]any) (json.RawMessage, error) {
	id := pluginID(ctx, params)
	if id == "" {
		return nil, &rpc.Error{Message: "no model plugin"}
	}
	return registry.Default.Call(ctx, id, method, params, timeout)
}

// pluginID resolves which model plugin serves this call: the project's configured
// model plugin (a video project routes to "siglip"), falling back to the first
// healthy provider of the model capability.
func pluginID(ctx context.Context, params map[string]any) string {
	if project, ok := params["project"].(string); ok && project != "" {
		if p, err := projects.Default.Get(ctx, project); err == nil && p != nil {
			if id := p.Model(); id != "" && registry.Default.Get(id) != nil {
				return id
			}
		}
	}
	if plugin := registry.Default.Provider(Capability); plugin != nil {
		return plugin.ID
	}
	return ""
}

// Embed warms embeddings for the given refs; returns the refs now embedded.
func Embed(ctx context.Context, refs []string, project string) ([]string, error) {
	raw, err := call(ctx, "embed", map[string]any{"refs": refs, "project": project})
	if err != nil {
		return nil, err
	}
	var result struct {
		Embedded []string `json:"embedded"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	return result.Embedded, nil
}

// AdjacentSimilarity returns the cosine similarity of each consecutive pair of refs —
// one score fewer than there are refs. Scene segmentation uses it to decide which
// neighbouring clips are the same content; only these scalars cross the wire, so the
// decision itself stays in the core where it is testable without a model.
func AdjacentSimilarity(ctx context.Context, refs []string, project string) ([]float64, error) {
	raw, err := call(ctx, "similarity", map[string]any{"refs": refs, "project": project})
	if err != nil {
		return nil, err
	}
	var result struct {
		Scores []float64 `json:"scores"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	return result.Scores, nil
}

// SearchHit is one ref and how well it matched a text query.
type SearchHit struct {
	Ref   string  `json:"ref"`
	Score float64 `json:"score"`
}

// SearchResult is a text search over already-embedded entities. Unembedded reports how
// many candidates had no vector to compare, so the caller can say "8 of these have not
// been embedded yet" instead of quietly returning a short list.
type SearchResult struct {
	Results    []SearchHit `json:"results"`
	Scored     int         `json:"scored"`
	Unembedded int         `json:"unembedded"`
	Message    string      `json:"message"`
}

// Search ranks refs against a free-text query using the backbone's text tower. It reads
// the vectors that already exist and embeds nothing, so it stays fast enough to run on
// a keystroke.
func Search(ctx context.Context, query string, refs []string, project string, limit int) (SearchResult, error) {
	raw, err := callWithin(ctx, readTimeout, "search", map[string]any{
		"query": query, "refs": refs, "project": project, "limit": limit,
	})
	if err != nil {
		return SearchResult{}, err
	}
	var result SearchResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return SearchResult{}, err
	}
	return result, nil
}

// Status is the model plugin's per-project state.
type Status struct {
	Backbone string `json:"backbone"`
	Dim      int    `json:"dim"`
	PoolSize int    `json:"pool_size"`
	Trained  bool   `json:"trained"`
}

// StatusOf returns the pool status for a project.
func StatusOf(ctx context.Context, classes []string, project string) (Status, error) {
	raw, err := callWithin(ctx, readTimeout, "status", map[string]any{"classes": classes, "project": project})
	if err != nil {
		return Status{}, err
	}
	var status Status
	if err := json.Unmarshal(raw, &status); err != nil {
		return Status{}, err
	}
	return status, nil
}

// PoolSize returns the number of labeled examples in a project's pool.
func PoolSize(ctx context.Context, project string) int {
	status, err := StatusOf(ctx, nil, project)
	if err != nil {
		return 0
	}
	return status.PoolSize
}

// Forget drops refs from a project's pool and vector cache. Needed when an entity's
// identity changes — a trimmed span gets a new media-fragment ref, and the old row
// would otherwise linger as a training example for a range that no longer exists.
// Not every model plugin implements it, so callers treat the error as advisory.
func Forget(ctx context.Context, refs []string, project string) (int, error) {
	raw, err := call(ctx, "forget", map[string]any{"refs": refs, "project": project})
	if err != nil {
		return 0, err
	}
	var result struct {
		Removed int `json:"removed"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return 0, err
	}
	return result.Removed, nil
}

// LabeledExample is one (ref, labels) training row sent to the pool.
type LabeledExample struct {
	Ref    string   `json:"ref"`
	Labels []string `json:"labels"`
}

// Train folds labeled examples into a project's pool and refits the head.
func Train(ctx context.Context, labeled []LabeledExample, classes []string, project string) error {
	_, err := call(ctx, "train", map[string]any{"labeled": labeled, "classes": classes, "project": project})
	return err
}

// Predict returns per-ref class probabilities.
func Predict(ctx context.Context, refs, classes []string, project string) (map[string]map[string]float64, error) {
	raw, err := call(ctx, "predict", map[string]any{"refs": refs, "classes": classes, "project": project})
	if err != nil {
		return nil, err
	}
	var result struct {
		Predictions []struct {
			Ref   string             `json:"ref"`
			Probs map[string]float64 `json:"probs"`
		} `json:"predictions"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	out := make(map[string]map[string]float64, len(result.Predictions))
	for _, prediction := range result.Predictions {
		out[prediction.Ref] = prediction.Probs
	}
	return out, nil
}

// Rank orders refs most-uncertain-first. Falls back to the input order on failure.
func Rank(ctx context.Context, refs, classes []string, project string) []string {
	raw, err := callWithin(ctx, readTimeout, "rank", map[string]any{"refs": refs, "classes": classes, "project": project})
	if err != nil {
		return refs
	}
	var result struct {
		Order []string `json:"order"`
	}
	if err := json.Unmarshal(raw, &result); err != nil || result.Order == nil {
		return refs
	}
	return result.Order
}

// DupCluster is a near-duplicate cluster in terms of image refs.
type DupCluster struct {
	Keep  string   `json:"keep"`
	Dupes []string `json:"dupes"`
}

// DuplicatesResult clusters near-duplicate refs (the caller maps refs back to image ids).
type DuplicatesResult struct {
	Clusters   []DupCluster `json:"clusters"`
	Duplicates []string     `json:"duplicates"`
	Count      int          `json:"count"`
}

// Duplicates finds near-duplicate images by cosine similarity of their embeddings.
func Duplicates(ctx context.Context, refs []string, threshold float64, project string) (DuplicatesResult, error) {
	raw, err := call(ctx, "duplicates", map[string]any{"refs": refs, "threshold": threshold, "project": project})
	if err != nil {
		return DuplicatesResult{}, err
	}
	var result DuplicatesResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return DuplicatesResult{}, err
	}
	return result, nil
}

// Insights returns cross-validated per-class metrics (raw passthrough to the API).
func Insights(ctx context.Context, project string) (json.RawMessage, error) {
	return call(ctx, "insights", map[string]any{"project": project})
}

// PoolDump returns the pool's (ref, labels) rows for dataset export.
func PoolDump(ctx context.Context, project string) ([]LabeledExample, error) {
	raw, err := call(ctx, "pool_dump", map[string]any{"project": project})
	if err != nil {
		return nil, err
	}
	var result struct {
		Entries []LabeledExample `json:"entries"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	return result.Entries, nil
}
