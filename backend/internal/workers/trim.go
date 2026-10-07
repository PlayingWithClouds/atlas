package workers

import (
	"context"
	"fmt"

	"atlas/backend/internal/config"
	"atlas/backend/internal/hub"
	"atlas/backend/internal/jobs"
	"atlas/backend/internal/labeling"
	"atlas/backend/internal/modelclient"
	"atlas/backend/internal/notifications"
	"atlas/backend/internal/sessions"
	"atlas/backend/internal/sources"
	"atlas/backend/internal/store"
)

// runTrimNode pulls clip boundaries onto nearby scene cuts. A session cut into fixed
// windows can be corrected this way without re-segmenting it, which would replace every
// entity; here only the clips that sit near a real cut move, and they keep their idx and
// their labels.
func runTrimNode(runCtx RunContext, node config.WorkflowNode, job *jobs.Job, inputs []any) (any, error) {
	ctx := context.Background()
	session := runCtx.Session
	items := itemsFromInputs(inputs)
	job.Update(map[string]any{"total": len(items), "phase": node.Type})

	spec := sources.SpecFrom(session.Video)
	if spec == nil || spec.URL == "" {
		return items, nil
	}
	tolerance := floatParam(node.Params, "tolerance", 1)
	minLen := floatParam(node.Params, "minLen", 2)

	cuts, ok := sources.EnsureSceneCuts(spec, session.ID, floatParam(node.Params, "cutScore", 0.3))
	if !ok {
		notifications.Notify(fmt.Sprintf("Trim skipped — no scene cuts detected in %q", session.Label),
			session.ID, "info")
		return items, nil
	}

	st := store.Open(session.ID, classesFor(ctx, session.Project))
	byRef, err := loadRefIndex(ctx, st)
	if err != nil {
		return nil, err
	}

	moved := 0
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		job.Tick(1)
		trimmed, changed := trimItem(ctx, session, st, byRef, item, cuts, spec.Duration, tolerance, minLen)
		out = append(out, trimmed)
		if changed {
			moved++
		}
	}
	if moved > 0 {
		hub.Default.Notify()
		notifications.Notify(fmt.Sprintf("Trimmed %d clips in %q onto scene cuts", moved, session.Label),
			session.ID, "info")
	}
	return out, nil
}

// trimItem moves one clip's range and returns the item as it now stands. A clip whose
// range does not change, or that has no row to update, passes through untouched.
func trimItem(ctx context.Context, session *sessions.Session, st *store.Store, byRef map[string]int,
	item map[string]any, cuts []float64, duration, tolerance, minLen float64) (map[string]any, bool) {

	start, startOK := toFloat(item["t_start"])
	end, endOK := toFloat(item["t_end"])
	oldRef := itemRef(item)
	idx, known := byRef[oldRef]
	if !startOK || !endOK || !known {
		return item, false
	}

	newStart, newEnd := snapToCuts(start, end, cuts, duration, tolerance, minLen)
	if newStart == start && newEnd == end {
		return item, false
	}
	base, _, _, ok := store.SplitSpanRef(oldRef)
	if !ok {
		return item, false
	}

	newRef := store.SpanRef(base, newStart, newEnd)
	if err := st.SetSpan(ctx, idx, newRef, newStart, newEnd); err != nil {
		return item, false
	}
	rebindSpanVector(ctx, session, st, idx, oldRef, newRef, item)

	trimmed := make(map[string]any, len(item))
	for key, value := range item {
		trimmed[key] = value
	}
	trimmed["ref"] = newRef
	trimmed["t_start"] = newStart
	trimmed["t_end"] = newEnd
	// The vector filed under the old ref is gone, so downstream nodes must treat this
	// clip as unembedded until something embeds the new range.
	trimmed["embedded"] = false
	return trimmed, true
}

// snapToCuts pulls each edge to the nearest cut within tolerance. Edges move
// independently, and a move that would leave the clip shorter than minLen is refused —
// a boundary is only worth fixing if what is left is still labelable.
func snapToCuts(start, end float64, cuts []float64, duration, tolerance, minLen float64) (float64, float64) {
	newStart := nearestCut(start, cuts, tolerance)
	newEnd := nearestCut(end, cuts, tolerance)
	if duration > 0 && newEnd > duration {
		newEnd = duration
	}
	if newEnd-newStart < minLen {
		return start, end
	}
	return newStart, newEnd
}

// nearestCut returns the cut closest to seconds within tolerance, or seconds unchanged.
func nearestCut(seconds float64, cuts []float64, tolerance float64) float64 {
	best, distance := seconds, tolerance
	for _, cut := range cuts {
		gap := cut - seconds
		if gap < 0 {
			gap = -gap
		}
		if gap <= distance {
			best, distance = cut, gap
		}
	}
	return best
}

// rebindSpanVector moves the pool entry that was filed under the old range, mirroring
// the manual trim path in api/span.go: forget the stale vector, and re-file a labeled
// clip's training example under its new ref.
func rebindSpanVector(ctx context.Context, session *sessions.Session, st *store.Store,
	idx int, oldRef, newRef string, item map[string]any) {

	if !modelclient.Available() {
		return
	}
	// Advisory: a model plugin without "forget" just keeps the stale row.
	_, _ = modelclient.Forget(ctx, []string{oldRef}, session.Project)

	status, _ := item["status"].(string)
	if status != store.StatusLabeled {
		return
	}
	annotations, err := st.Annotations(ctx, idx)
	if err != nil {
		return
	}
	// ConfirmLabel embeds the new ref and files the example under it.
	_ = labeling.ConfirmLabel(ctx, session, st, idx, annotations)
}
