package api

import (
	"context"
	"net/http"

	"atlas/backend/internal/hub"
	"atlas/backend/internal/jobs"
	"atlas/backend/internal/labeling"
	"atlas/backend/internal/modelclient"
	"atlas/backend/internal/sessions"
	"atlas/backend/internal/sources"
	"atlas/backend/internal/store"
)

// handleSpanUpdate moves a temporal span's time range — the fixed windows a segment
// node lays down rarely land exactly on the action. The response returns as soon as
// the range is stored; re-embedding the new range runs as a job.
func handleSpanUpdate(w http.ResponseWriter, r *http.Request) {
	session, st, ok := requireSession(w, r)
	if !ok {
		return
	}
	var body struct {
		TStart float64 `json:"t_start"`
		TEnd   float64 `json:"t_end"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return
	}

	idx := pathInt(r, "image_id")
	image, err := st.GetImage(r.Context(), idx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if image == nil {
		writeError(w, http.StatusNotFound, "image not found")
		return
	}
	if image.TStart == nil || image.TEnd == nil {
		writeError(w, http.StatusBadRequest, "not a temporal span")
		return
	}
	base, _, _, isSpan := store.SplitSpanRef(image.Ref)
	if !isSpan {
		writeError(w, http.StatusBadRequest, "span has no media-fragment ref")
		return
	}

	duration := 0.0
	if spec := sources.SpecFrom(session.Video); spec != nil {
		duration = spec.Duration
	}
	tStart, tEnd, valid := normalizeSpan(body.TStart, body.TEnd, duration)
	if !valid {
		writeError(w, http.StatusBadRequest, "invalid time range")
		return
	}

	newRef := store.SpanRef(base, tStart, tEnd)
	if newRef == image.Ref {
		writeJSON(w, http.StatusOK, spanResponse(idx, tStart, tEnd, image.Status, image.Embedded, false))
		return
	}
	if err := st.SetSpan(r.Context(), idx, newRef, tStart, tEnd); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	hub.Default.Notify()

	reembedSpan(session, st, idx, image.Ref, newRef, image.Status)
	writeJSON(w, http.StatusOK, spanResponse(idx, tStart, tEnd, image.Status, false, true))
}

// normalizeSpan clamps a requested range into the video and enforces the shortest
// clip the backbone can sample.
func normalizeSpan(tStart, tEnd, duration float64) (float64, float64, bool) {
	if tStart < 0 || tEnd <= tStart {
		return 0, 0, false
	}
	if duration > 0 {
		if tStart >= duration {
			return 0, 0, false
		}
		if tEnd > duration {
			tEnd = duration
		}
	}
	if tEnd-tStart < minSpanSeconds {
		tEnd = tStart + minSpanSeconds
	}
	return tStart, tEnd, true
}

// reembedSpan queues the pool bookkeeping a moved range implies: drop the vector
// filed under the old ref, then embed the new one — re-training first when the span
// was already labeled, so its example follows it to the new ref.
func reembedSpan(session *sessions.Session, st *store.Store, idx int, oldRef, newRef, status string) {
	jobs.Default.Submit("embed", session.ID, 1, map[string]any{"idx": idx}, func(job *jobs.Job) error {
		ctx := context.Background()
		if !modelclient.Available() {
			return nil
		}
		// Advisory: a model plugin without "forget" just keeps the stale row.
		if _, err := modelclient.Forget(ctx, []string{oldRef}, session.Project); err != nil {
			job.Update(map[string]any{"phase": "forget unsupported"})
		}
		if status == store.StatusLabeled {
			annotations, err := st.Annotations(ctx, idx)
			if err != nil {
				return err
			}
			// Train embeds the new ref and files the example under it.
			if err := labeling.ConfirmLabel(ctx, session, st, idx, annotations); err != nil {
				return err
			}
		} else if embedded, _ := modelclient.Embed(ctx, []string{newRef}, session.Project); len(embedded) == 0 {
			return nil
		}
		_ = st.MarkEmbedded(ctx, []int{idx})
		job.Tick(1)
		hub.Default.Notify()
		return nil
	})
}

func spanResponse(idx int, tStart, tEnd float64, status string, embedded, reembedding bool) map[string]any {
	return map[string]any{
		"ok": true, "id": idx, "t_start": tStart, "t_end": tEnd,
		"status": status, "embedded": embedded, "reembedding": reembedding,
	}
}
