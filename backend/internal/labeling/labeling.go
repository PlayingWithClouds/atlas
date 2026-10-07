// Package labeling holds the core labeling operations over a session's store: confirm a
// label (and fold it into the model plugin's pool), compute suggestions, build the image
// response, and pick the next image. All ML is delegated to the model plugin; there is no
// in-core fallback.
package labeling

import (
	"context"

	"atlas/backend/internal/modelclient"
	"atlas/backend/internal/primitives"
	"atlas/backend/internal/projects"
	"atlas/backend/internal/sessions"
	"atlas/backend/internal/store"
)

const SuggestionThreshold = 0.5

// isTagProject reports whether the session's project labels with tags.
func isTagProject(ctx context.Context, session *sessions.Session) bool {
	project, err := projects.Default.Get(ctx, session.Project)
	if err != nil || project == nil {
		return true // default assumption: tag project
	}
	return project.IsTag()
}

// ConfirmLabel persists a human annotation set and folds it into the project's pool.
func ConfirmLabel(ctx context.Context, session *sessions.Session, st *store.Store, idx int, annotations []primitives.Annotation) error {
	if err := st.SetAnnotations(ctx, idx, annotations); err != nil {
		return err
	}
	if !isTagProject(ctx, session) || !modelclient.Available() {
		return nil
	}
	ref, err := st.Ref(ctx, idx)
	if err != nil || ref == "" {
		return err
	}
	labels, _ := st.Labels(ctx, idx)
	_ = modelclient.Train(ctx, []modelclient.LabeledExample{{Ref: ref, Labels: labels}}, st.Classes, session.Project)
	return nil
}

// BackfillPool folds a session's already-labeled images into the project's pool.
func BackfillPool(ctx context.Context, session *sessions.Session, st *store.Store) {
	if !isTagProject(ctx, session) || !modelclient.Available() {
		return
	}
	indices, err := st.LabeledIndices(ctx)
	if err != nil || len(indices) == 0 {
		return
	}
	var examples []modelclient.LabeledExample
	for _, idx := range indices {
		image, err := st.GetImage(ctx, idx)
		if err != nil || image == nil {
			continue
		}
		examples = append(examples, modelclient.LabeledExample{
			Ref: image.Ref, Labels: primitives.LabelsOf(image.Annotations),
		})
	}
	if len(examples) > 0 {
		_ = modelclient.Train(ctx, examples, st.Classes, session.Project)
	}
}

// SuggestionsFor returns the model's class probabilities for one image.
func SuggestionsFor(ctx context.Context, session *sessions.Session, st *store.Store, idx int) map[string]float64 {
	if !modelclient.Available() {
		return map[string]float64{}
	}
	ref, err := st.Ref(ctx, idx)
	if err != nil || ref == "" {
		return map[string]float64{}
	}
	predictions, err := modelclient.Predict(ctx, []string{ref}, st.Classes, session.Project)
	if err != nil {
		return map[string]float64{}
	}
	if probs, ok := predictions[ref]; ok {
		return probs
	}
	return map[string]float64{}
}

// BuildImageResponse assembles the per-image payload the frontend renders.
func BuildImageResponse(ctx context.Context, session *sessions.Session, st *store.Store, idx int) map[string]any {
	image, _ := st.GetImage(ctx, idx)
	annotations := []primitives.Annotation{}
	status := store.StatusPending
	if image != nil {
		if image.Annotations != nil {
			annotations = image.Annotations
		}
		status = image.Status
	}
	response := map[string]any{
		"done":        false,
		"id":          idx,
		"suggestions": SuggestionsFor(ctx, session, st, idx),
		"existing":    primitives.LabelsOf(annotations),
		"annotations": annotations,
		"status":      status,
		"threshold":   SuggestionThreshold,
	}
	// A temporal span carries its range so the UI can loop it. The ref itself stays
	// server-side: a resolved stream URL is often signed.
	if image != nil && image.TStart != nil && image.TEnd != nil {
		response["t_start"] = *image.TStart
		response["t_end"] = *image.TEnd
	}
	return response
}

// PickNext chooses the next image to label. It returns (idx, "ok"), (-1, "waiting") when a
// producer is still ingesting, or (-1, "done").
func PickNext(ctx context.Context, session *sessions.Session, st *store.Store) (int, string) {
	region := !isTagProject(ctx, session)

	if region {
		pending, _ := st.Pending(ctx)
		if len(pending) == 0 {
			return doneOrWaiting(session)
		}
		return pending[0].Idx, "ok"
	}

	candidates, _ := st.PendingEmbedded(ctx)
	if len(candidates) == 0 {
		pending, _ := st.Pending(ctx)
		if len(pending) == 0 {
			return doneOrWaiting(session)
		}
		return pending[0].Idx, "ok"
	}

	if modelclient.Available() {
		refs := make([]string, len(candidates))
		byRef := make(map[string]int, len(candidates))
		for i, image := range candidates {
			refs[i] = image.Ref
			byRef[image.Ref] = image.Idx
		}
		order := modelclient.Rank(ctx, refs, st.Classes, session.Project)
		if len(order) > 0 {
			if idx, ok := byRef[order[0]]; ok {
				return idx, "ok"
			}
		}
	}
	return candidates[0].Idx, "ok"
}

func doneOrWaiting(session *sessions.Session) (int, string) {
	if session.Producing {
		return -1, "waiting"
	}
	return -1, "done"
}
